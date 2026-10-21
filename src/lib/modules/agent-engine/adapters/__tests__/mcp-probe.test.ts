// MCP 测试连接的真实连接测试:本地起真的 MCP 服务(SDK 自带的服务端,Streamable HTTP 与旧 SSE 各一种)
// 和真的 stdio 子进程。验证列出工具、各类失败的归类、密钥不出现在结果里,以及【从不调用工具】。
import { writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGuardedFetch } from "@/lib/modules/integration/adapters/guarded-fetch";
import { isAddressAllowed } from "@/lib/modules/integration/domain/webhook-policy";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { probeMcp } from "../mcp-probe";

/** 工具被调用的次数:测试连接必须始终是 0 */
let toolCalls = 0;

function mcpServer() {
  const server = new McpServer({ name: "fake-mcp", version: "9.9.9" });
  for (const name of ["search", "create_issue"]) {
    server.registerTool(name, { description: `${name} tool` }, async () => {
      toolCalls += 1;
      return { content: [{ type: "text", text: "called" }] };
    });
  }
  return server;
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  toolCalls = 0;
});

async function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

/** 无状态的 Streamable HTTP MCP 服务;token 不为空时要求 ?token= 匹配 */
async function streamable(token?: string) {
  return listen(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (token && u.searchParams.get("token") !== token) {
      res.writeHead(401).end("bad token");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = mcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString()));
    res.on("close", () => void server.close());
  });
}

/** 旧的 SSE MCP 服务:GET /sse 建流,POST /messages 发消息;POST /sse 回 405 */
async function legacySse() {
  const transports = new Map<string, SSEServerTransport>();
  return listen(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/sse" && req.method === "GET") {
      const t = new SSEServerTransport("/messages", res);
      transports.set(t.sessionId, t);
      await mcpServer().connect(t);
      return;
    }
    if (u.pathname === "/messages" && req.method === "POST") {
      const t = transports.get(u.searchParams.get("sessionId") ?? "");
      if (!t) return void res.writeHead(404).end();
      await t.handlePostMessage(req, res);
      return;
    }
    res.writeHead(405).end();
  });
}

const allowAll = { fetch: createGuardedFetch({ allowAddress: () => true }), stdioHome: tmpdir() };
const http_ = (url: string) => ({ name: "t", type: "http" as const, url });

describe("probeMcp:http", () => {
  it("Streamable HTTP:握手、列出工具与服务名;不调用工具", async () => {
    const base = await streamable();
    const r = await probeMcp(http_(`${base}/mcp`), [], allowAll);
    expect(r).toMatchObject({
      ok: true,
      transport: "streamable_http",
      server: { name: "fake-mcp", version: "9.9.9" },
      tools: [
        { name: "search", description: "search tool" },
        { name: "create_issue", description: "create_issue tool" },
      ],
    });
    expect(toolCalls).toBe(0);
  });

  it("旧的 SSE 服务:POST 回 405 时退回 SSE 方式", async () => {
    const base = await legacySse();
    const r = await probeMcp(http_(`${base}/sse`), [], allowAll);
    expect(r).toMatchObject({ ok: true, transport: "sse" });
    expect(r.ok && r.tools.map((t) => t.name)).toEqual(["search", "create_issue"]);
    expect(toolCalls).toBe(0);
  });

  it("token 不对:认证失败;报错里不出现地址里的 token", async () => {
    const base = await streamable("right-token");
    const r = await probeMcp(
      http_(`${base}/mcp?token=wrong-secret-token`),
      ["wrong-secret-token"],
      allowAll,
    );
    expect(r).toMatchObject({ ok: false, kind: "auth" });
    expect(JSON.stringify(r)).not.toContain("wrong-secret-token");
  });

  it("要求 OAuth(401 带 resource_metadata):单独说明平台暂不支持", async () => {
    const base = await listen((_req, res) => {
      res
        .writeHead(401, {
          "WWW-Authenticate":
            'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"',
        })
        .end();
    });
    const r = await probeMcp(http_(`${base}/mcp`), [], allowAll);
    expect(r).toMatchObject({ ok: false, kind: "oauth" });
  });

  it("不是 MCP 服务(普通网页):not_mcp;对方回显的密钥被抹掉", async () => {
    const base = await listen((req, res) => {
      res.writeHead(500, { "content-type": "text/html" }).end(`<h1>error ${req.url}</h1>`);
    });
    const r = await probeMcp(http_(`${base}/mcp?key=echo-secret-1234`), [], allowAll);
    expect(r).toMatchObject({ ok: false, kind: "not_mcp" });
    expect(JSON.stringify(r)).not.toContain("echo-secret-1234");
  });

  it("对方一直不回:按期限超时", async () => {
    const base = await listen(() => {});
    const r = await probeMcp(http_(`${base}/mcp`), [], { ...allowAll, httpTimeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, kind: "timeout" });
  });

  it("端口没人监听:连不上", async () => {
    const base = await listen(() => {});
    const port = new URL(base).port;
    await new Promise((r) => servers.pop()?.close(() => r(null)));
    const r = await probeMcp(http_(`http://127.0.0.1:${port}/mcp`), [], allowAll);
    expect(r).toMatchObject({ ok: false, kind: "unreachable" });
    expect(r.ok === false && r.message).toContain("ECONNREFUSED");
  });

  it("地址规则同 webhook:回环直接拒绝;域名解析到回环也拒绝(连接时校验),对方收不到请求", async () => {
    let hits = 0;
    const base = await listen((_req, res) => {
      hits += 1;
      res.writeHead(500).end();
    });
    const port = new URL(base).port;
    const guarded = (resolve?: (h: string) => Promise<{ address: string; family: number }[]>) => ({
      fetch: createGuardedFetch({ allowAddress: (ip) => isAddressAllowed(ip, true), resolve }),
      stdioHome: tmpdir(),
    });
    const literal = await probeMcp(http_(`${base}/mcp`), [], guarded());
    expect(literal).toMatchObject({ ok: false, kind: "forbidden_address" });
    const rebound = await probeMcp(
      http_(`http://mcp.example.test:${port}/mcp`),
      [],
      guarded(async () => [{ address: "127.0.0.1", family: 4 }]),
    );
    expect(rebound).toMatchObject({ ok: false, kind: "forbidden_address" });
    expect(hits).toBe(0);
  });
});

describe("probeMcp:stdio", () => {
  const serverScript = async (extra = "") => {
    const file = path.join(tmpdir(), `owa-fake-stdio-${Date.now()}-${Math.random()}.mjs`);
    const sdk = path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm/server");
    await writeFile(
      file,
      `import { McpServer } from ${JSON.stringify(`${sdk}/mcp.js`)};
import { StdioServerTransport } from ${JSON.stringify(`${sdk}/stdio.js`)};
import { appendFileSync } from "node:fs";
${extra}
const server = new McpServer({ name: "fake-stdio", version: "1.0.0" });
server.registerTool("read_file", { description: "read" }, async () => {
  appendFileSync(process.env.CALL_LOG, "called\\n");
  return { content: [{ type: "text", text: "x" }] };
});
await server.connect(new StdioServerTransport());
`,
    );
    return file;
  };

  it("启动程序、握手、列出工具后结束进程;不调用工具;HOME 指向智能体共用的 HOME", async () => {
    const callLog = path.join(tmpdir(), `owa-call-log-${Date.now()}`);
    const homeLog = path.join(tmpdir(), `owa-home-log-${Date.now()}`);
    const file = await serverScript(
      `appendFileSync(${JSON.stringify(homeLog)}, process.env.HOME + "|" + (process.env.OWA_SECRET ?? "none"));`,
    );
    process.env.OWA_SECRET = "platform-secret";
    try {
      const r = await probeMcp(
        {
          name: "s",
          type: "stdio",
          command: process.execPath,
          args: [file],
          env: { CALL_LOG: callLog },
        },
        [],
        { ...allowAll, stdioHome: "/tmp/agent-home-for-test" },
      );
      expect(r).toMatchObject({ ok: true, transport: "stdio", server: { name: "fake-stdio" } });
      expect(r.ok && r.tools.map((t) => t.name)).toEqual(["read_file"]);
    } finally {
      Reflect.deleteProperty(process.env, "OWA_SECRET");
    }
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(callLog, "utf8")).rejects.toThrow(); // 从没被调用
    // 平台自己的环境变量不传给 MCP 程序
    expect(await readFile(homeLog, "utf8")).toBe("/tmp/agent-home-for-test|none");
  });

  it("找不到命令、程序启动就退出:process_failed,带错误输出且抹掉密钥", async () => {
    const missing = await probeMcp(
      { name: "s", type: "stdio", command: "owa-no-such-command-xyz" },
      [],
      allowAll,
    );
    expect(missing).toMatchObject({ ok: false, kind: "process_failed" });
    const file = path.join(tmpdir(), `owa-crash-${Date.now()}.mjs`);
    await writeFile(
      file,
      `console.error("boom with key " + process.env.API_KEY); process.exit(3);`,
    );
    const crashed = await probeMcp(
      {
        name: "s",
        type: "stdio",
        command: process.execPath,
        args: [file],
        env: { API_KEY: "sk-crash-secret" },
      },
      ["sk-crash-secret"],
      allowAll,
    );
    expect(crashed).toMatchObject({ ok: false, kind: "process_failed" });
    expect(crashed.ok === false && crashed.message).toContain("boom with key ***");
  });
});
