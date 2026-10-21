// MCP 测试连接:握手(initialize)并列出工具(tools/list),【不调用任何工具】。
//
// http:先按 Streamable HTTP 连(SDK 运行时的 http 类型就是它),对方回 404/405 再退回旧的 SSE 方式。
// 出站请求只走带地址守卫的 fetch(见 guarded-fetch.ts),拿不到 OAuth 令牌,认证只看地址里带的。
// stdio:启动配置里的程序,握手、列工具后立即关闭进程;HOME 指向智能体共用的 HOME,
// 环境只有 SDK 默认放行的几项(PATH、HOME 等)加上配置里的 env,不带平台自己的密钥。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type McpCheckFailure,
  type McpCheckResult,
  type McpCheckTool,
  redactSecrets,
} from "@/lib/modules/agent/domain/mcp-check";
import {
  AddressRejected,
  type GuardedFetch,
} from "@/lib/modules/integration/adapters/guarded-fetch";
import type { McpDef } from "@/lib/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface McpProbeDeps {
  fetch: GuardedFetch;
  /** stdio 进程的 HOME(智能体共用的 HOME,与运行时一致) */
  stdioHome: string;
  httpTimeoutMs?: number;
  /** stdio 首次启动可能要下载安装包(npx),给得长一些 */
  stdioTimeoutMs?: number;
}

const CLIENT_INFO = { name: "open-web-agents-check", version: "1.0.0" };
/** 工具最多列这么多(分页最多翻这么多页) */
const MAX_TOOLS = 200;
const MAX_PAGES = 10;

class ProbeTimeout extends Error {}

/** 最后一次 HTTP 响应:认证失败时据此区分要不要 OAuth */
interface LastResponse {
  status: number;
  wwwAuthenticate: string | null;
}

function chain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur = err;
  for (let i = 0; i < 6 && cur; i++) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

const NETWORK_CODES: Record<string, string> = {
  ECONNREFUSED: "连接被拒绝",
  ENOTFOUND: "域名解析不到",
  EAI_AGAIN: "域名解析失败",
  ECONNRESET: "连接被对方断开",
  ETIMEDOUT: "连接超时",
  EHOSTUNREACH: "主机不可达",
  ENETUNREACH: "网络不可达",
  CERT_HAS_EXPIRED: "对方证书已过期",
  DEPTH_ZERO_SELF_SIGNED_CERT: "对方证书是自签名的",
  SELF_SIGNED_CERT_IN_CHAIN: "对方证书链里有自签名证书",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "无法校验对方证书",
  ERR_TLS_CERT_ALTNAME_INVALID: "对方证书与域名不匹配",
};

function classify(
  err: unknown,
  last: LastResponse | null,
): { kind: McpCheckFailure; message: string } {
  const errs = chain(err);
  if (errs.some((e) => e instanceof AddressRejected)) {
    const e = errs.find((x) => x instanceof AddressRejected) as AddressRejected;
    return {
      kind: "forbidden_address",
      message: `${e.message}。平台不允许测试连接回环、云元数据等地址;内网地址需部署方开启 OWA_WEBHOOK_ALLOW_PRIVATE`,
    };
  }
  if (
    errs.some(
      (e) =>
        e instanceof ProbeTimeout ||
        (e as { code?: unknown })?.code === -32001 ||
        (e as { name?: string })?.name === "AbortError",
    )
  ) {
    return { kind: "timeout", message: "等待对方响应超时" };
  }
  if (last && (last.status === 401 || last.status === 403)) {
    const oauth =
      last.status === 401 &&
      /resource_metadata|authorization_uri/i.test(last.wwwAuthenticate ?? "");
    return oauth
      ? {
          kind: "oauth",
          message: "对方要求 OAuth 登录授权,平台暂不支持需要 OAuth 登录的 MCP",
        }
      : {
          kind: "auth",
          message: `认证失败(HTTP ${last.status}):检查地址里的 token 或引用的密钥变量`,
        };
  }
  for (const e of errs) {
    const code = (e as { code?: unknown })?.code;
    if (typeof code === "string" && NETWORK_CODES[code]) {
      return { kind: "unreachable", message: `连不上:${NETWORK_CODES[code]}(${code})` };
    }
  }
  if (errs.some((e) => e instanceof StreamableHTTPError) || last) {
    const status = last ? `HTTP ${last.status}` : "响应格式不对";
    return {
      kind: "not_mcp",
      message: `对方不像是 MCP 服务(${status}):${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    kind: "unreachable",
    message: `连接失败:${err instanceof Error ? err.message : String(err)}`,
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 握手 + 列工具;结束时总会关闭连接(stdio 即结束进程) */
async function handshake(
  transport: Transport,
  timeoutMs: number,
): Promise<{ server: { name?: string; version?: string }; tools: McpCheckTool[] }> {
  const client = new Client(CLIENT_INFO);
  try {
    await withTimeout(client.connect(transport, { timeout: timeoutMs }), timeoutMs);
    const info = client.getServerVersion();
    const tools: McpCheckTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page++) {
      const r = await withTimeout(
        client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs }),
        timeoutMs,
      );
      for (const t of r.tools) {
        if (tools.length >= MAX_TOOLS) break;
        tools.push({
          name: t.name,
          ...(t.description ? { description: t.description.slice(0, 500) } : {}),
        });
      }
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return { server: { name: info?.name, version: info?.version }, tools };
  } finally {
    await client.close().catch(() => {});
  }
}

async function probeHttp(
  def: McpDef,
  secrets: string[],
  deps: McpProbeDeps,
): Promise<McpCheckResult> {
  const timeoutMs = deps.httpTimeoutMs ?? 10_000;
  const url = new URL(def.url as string);
  let last: LastResponse | null = null;
  const fetchTracked: GuardedFetch = async (input, init) => {
    const res = await deps.fetch(input, init);
    if (!res.ok)
      last = { status: res.status, wwwAuthenticate: res.headers.get("www-authenticate") };
    return res;
  };
  const started = Date.now();
  const done = (
    transport: "streamable_http" | "sse",
    r: Awaited<ReturnType<typeof handshake>>,
  ): McpCheckResult => ({ ok: true, transport, ...r, latencyMs: Date.now() - started });
  try {
    return done(
      "streamable_http",
      await handshake(new StreamableHTTPClientTransport(url, { fetch: fetchTracked }), timeoutMs),
    );
  } catch (err) {
    // 旧的 SSE 服务对 POST 回 404/405:退回 SSE 方式再试一次
    const status = (last as LastResponse | null)?.status;
    if (status !== 404 && status !== 405) {
      const c = classify(err, last);
      return { ok: false, kind: c.kind, message: redactSecrets(c.message, secrets, def.url) };
    }
  }
  last = null;
  try {
    return done(
      "sse",
      await handshake(
        new SSEClientTransport(url, {
          fetch: fetchTracked,
          eventSourceInit: { fetch: fetchTracked },
        }),
        timeoutMs,
      ),
    );
  } catch (err) {
    const c = classify(err, last);
    return { ok: false, kind: c.kind, message: redactSecrets(c.message, secrets, def.url) };
  }
}

async function probeStdio(
  def: McpDef,
  secrets: string[],
  deps: McpProbeDeps,
): Promise<McpCheckResult> {
  const timeoutMs = deps.stdioTimeoutMs ?? 60_000;
  const cwd = await mkdtemp(path.join(tmpdir(), "owa-mcp-check-"));
  let stderr = "";
  const started = Date.now();
  try {
    const transport = new StdioClientTransport({
      command: def.command as string,
      args: def.args ?? [],
      env: { ...(def.env ?? {}), HOME: deps.stdioHome },
      cwd,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const r = await handshake(transport, timeoutMs);
    return { ok: true, transport: "stdio", ...r, latencyMs: Date.now() - started };
  } catch (err) {
    if (
      chain(err).some(
        (e) => e instanceof ProbeTimeout || (e as { code?: unknown })?.code === -32001,
      )
    ) {
      return {
        ok: false,
        kind: "timeout",
        message: `程序 ${Math.round(timeoutMs / 1000)} 秒内没有完成握手`,
      };
    }
    const code = (err as { code?: unknown })?.code;
    const reason =
      code === "ENOENT"
        ? `找不到命令:${def.command}`
        : `程序启动失败或提前退出:${err instanceof Error ? err.message : String(err)}`;
    const tail = stderr.trim() ? `;错误输出:${stderr.trim().slice(-500)}` : "";
    return { ok: false, kind: "process_failed", message: redactSecrets(reason + tail, secrets) };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

/** 测试一个已替换好变量、已通过配置校验的 MCP。secrets 用于从结果里抹掉密钥 */
export function probeMcp(
  def: McpDef,
  secrets: string[],
  deps: McpProbeDeps,
): Promise<McpCheckResult> {
  return def.type === "stdio" ? probeStdio(def, secrets, deps) : probeHttp(def, secrets, deps);
}
