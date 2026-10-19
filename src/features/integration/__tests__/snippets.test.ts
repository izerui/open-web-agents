import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { buildSnippets, sampleFromSchema, sampleInput } from "@/features/integration/snippets";
import { validateInput } from "@/lib/modules/agent/domain/validate-output";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("sampleFromSchema + 校验复核", () => {
  // 每一条都要求:生成值能真的通过平台的入参校验,而不只是"长得像"
  const cases: [string, Record<string, unknown>][] = [
    [
      "必填整数 minimum: 1",
      { type: "object", required: ["n"], properties: { n: { type: "integer", minimum: 1 } } },
    ],
    [
      "数组 minItems: 2",
      {
        type: "object",
        required: ["xs"],
        properties: { xs: { type: "array", minItems: 2, items: { type: "string" } } },
      },
    ],
    ["exclusiveMinimum", { type: "number", exclusiveMinimum: 0 }],
    ["multipleOf", { type: "integer", minimum: 3, multipleOf: 5 }],
    ["minLength", { type: "string", minLength: 5 }],
    ["format: email", { type: "string", format: "email" }],
    ["const", { const: "fixed" }],
    ["oneOf", { oneOf: [{ type: "integer", minimum: 2 }, { type: "string" }] }],
    ["负数上限", { type: "integer", maximum: -3 }],
    [
      "嵌套对象",
      {
        type: "object",
        required: ["a"],
        properties: {
          a: {
            type: "object",
            required: ["b"],
            properties: { b: { type: "array", minItems: 3, items: { type: "boolean" } } },
          },
        },
      },
    ],
  ];

  for (const [name, schema] of cases) {
    it(`${name}:生成值通过 validateInput`, () => {
      const value = sampleFromSchema(schema);
      expect(validateInput(schema, value)).toEqual({ ok: true });
      expect(sampleInput(schema).valid).toBe(true);
    });
  }

  it("具体值:minimum 1 生成 1,minItems 2 生成 2 个", () => {
    expect(sampleFromSchema({ type: "integer", minimum: 1 })).toBe(1);
    expect(
      sampleFromSchema({ type: "array", minItems: 2, items: { type: "string" } }),
    ).toHaveLength(2);
  });

  it("生成不出合法值时如实标记,示例代码里写明需要按实际填写", () => {
    const schema = {
      type: "object",
      required: ["code"],
      properties: { code: { type: "string", pattern: "^[A-Z]{3}-\\d{4}$" } },
    };
    const s = sampleInput(schema);
    expect(s.valid).toBe(false);
    expect(s.issues.length).toBeGreaterThan(0);
    const snip = buildSnippets({
      origin: "http://x",
      agentId: "a",
      inputSchema: schema,
      hasOutputSchema: false,
    });
    for (const code of [snip.curl, snip.python, snip.node]) {
      expect(code).toContain("需要按实际填写");
    }
  });

  it("没有 inputSchema:文本入参,视为合法", () => {
    expect(sampleInput(undefined)).toEqual({ value: "你的输入", valid: true, issues: [] });
  });
});

describe("buildSnippets 文本内容", () => {
  const s = buildSnippets({
    origin: "https://owa.example.com",
    agentId: "a1",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", example: "it's 基本不等式" },
        ok: { type: "boolean" },
      },
    },
    hasOutputSchema: true,
  });

  it("curl:绝对地址、带 Key 与幂等键、单引号正确转义", () => {
    expect(s.curl).toContain("https://owa.example.com/api/agents/a1/invoke");
    expect(s.curl).toContain("X-Api-Key: $OWA_API_KEY");
    expect(s.curl).toContain("Idempotency-Key");
    expect(s.curl).toContain(`it'\\''s`);
    expect(s.curl).not.toContain("需要按实际填写");
  });

  it("三种示例都指明:同一把 Key 读取任务工作目录与订阅过程", () => {
    expect(s.curl).toContain("https://owa.example.com/api/sessions/<sessionId>/files");
    expect(s.curl).toContain("files?download=");
    expect(s.curl).toContain("/api/sessions/<sessionId>/events?runId=<taskId>");
    expect(s.python).toContain('session_id = r.json().get("sessionId")');
    expect(s.python).toContain("/events?runId={task_id}");
    expect(s.node).toContain("const { taskId, sessionId } = await r.json();");
    expect(s.node).toContain("/events?runId=");
  });

  it("Python:如实说明超时只停止等待、不取消底层请求", () => {
    expect(s.python).toContain("没有被取消");
    expect(s.python).toContain("无限期");
    expect(s.python).not.toContain("暂时");
  });

  it("Python:JSON 布尔值换成 Python 字面量", () => {
    expect(s.python).toContain('"ok": False');
    expect(s.python).toContain('print(res["structured"])');
  });
});

// ── 真正执行生成出来的示例代码 ────────────────────────────────────────────────
//
// 用真实的本地 HTTP 服务、在子进程里跑真实的 node / python3 + requests。
// 只模拟"快速返回 done:false"证明不了网络等待有界,所以这里专门有两种卡住的服务端:
// 请求进来后永不响应;发了响应头和半截 body 之后再也不动。

/** 测试里把轮询期限调到 1 秒,子进程整体时限 15 秒兜底 */
const DEADLINE_S = 1;

type Mode = "unauth" | "pending" | "hang" | "stall" | "trickle" | "tricklecl" | "reject" | "ok";

let server: http.Server;
let origin = "";
const hits: Record<string, number> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    // /api/agents/<mode>/invoke 与 /api/agents/<mode>/result —— 用 agentId / taskId 携带场景
    const m = /^\/api\/agents\/([a-z]+)\/(invoke|result)$/.exec(req.url ?? "");
    const mode = m?.[1] as Mode | undefined;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!m || !mode) return send(404, { error: "no route", code: "not_found" });
    hits[`${mode}:${m[2]}`] = (hits[`${mode}:${m[2]}`] ?? 0) + 1;
    if (m[2] === "invoke") {
      if (mode === "reject") return send(400, { error: "bad input", code: "input_invalid" });
      // 与真实接口同形:受理返回 taskId 与 sessionId
      return send(202, { taskId: mode, sessionId: `s-${mode}` });
    }
    switch (mode) {
      case "unauth":
        return send(401, { error: "invalid api key", code: "unauthorized" });
      case "pending":
        return send(200, { done: false, status: "running" });
      case "hang":
        return; // 永不响应
      case "stall":
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"done":'); // 响应头到了,body 永不结束
        return;
      case "trickle": {
        // 一直慢慢发空白字节,每次间隔都小于读超时 —— 只限"读间隔"的客户端会被拖住
        res.writeHead(200, { "Content-Type": "application/json" });
        const t = setInterval(() => res.write(" "), 300);
        res.on("close", () => clearInterval(t));
        return;
      }
      case "tricklecl": {
        // 同样慢速发送,但声明了很大的 Content-Length:不走 chunked 编码,
        // 客户端按固定块读取时可能一直凑不满一块,读间隔又始终不超时
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000000" });
        const t = setInterval(() => res.write(" "), 300);
        res.on("close", () => clearInterval(t));
        return;
      }
      default:
        return send(200, { done: true, status: "success", structured: { ok: 1 } });
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((ok) => server.close(ok));
});

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-snippet-"));

interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** 异步起子进程 —— 服务端就在本进程里,同步执行会把它一起卡死 */
function runFile(cmd: string, file: string): Promise<RunOutcome> {
  const t0 = Date.now();
  return new Promise((ok) => {
    execFile(
      cmd,
      [file],
      { env: { ...process.env, OWA_API_KEY: "k" }, timeout: 15_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
        ok({ code, stdout, stderr, ms: Date.now() - t0 });
      },
    );
  });
}

function snippetFor(mode: Mode) {
  return buildSnippets({
    origin,
    agentId: mode,
    inputSchema: {
      type: "object",
      required: ["n"],
      properties: { n: { type: "integer", minimum: 1 } },
    },
    hasOutputSchema: true,
    pollDeadlineSeconds: DEADLINE_S,
  });
}

const hasNode18 = Number(process.versions.node.split(".")[0]) >= 18;

describe.skipIf(!hasNode18)("Node 示例:真实网络下的结束行为", () => {
  const run = (mode: Mode) => {
    const file = path.join(outDir, `${mode}.mjs`);
    fs.writeFileSync(file, snippetFor(mode).node);
    return runFile(process.execPath, file);
  };

  it("受理成功、轮询返回 401(Key 被吊销):立刻带状态码报错,只轮询一次", async () => {
    const r = await run("unauth");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("查询结果失败 HTTP 401");
    expect(hits["unauth:result"]).toBe(1);
  });

  it("受理成功、下一次请求不返回:到期限按时结束", async () => {
    const r = await run("hang");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("等待结果超时");
    expect(r.ms).toBeLessThan(DEADLINE_S * 1000 + 2000);
  });

  it("响应头到了但 body 不结束:读 body 也在期限内被取消", async () => {
    const r = await run("stall");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("等待结果超时");
    expect(r.ms).toBeLessThan(DEADLINE_S * 1000 + 2000);
  });

  it("服务端持续慢速发送、永不结束:总时长仍受期限约束", async () => {
    const r = await run("trickle");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("等待结果超时");
    expect(r.ms).toBeLessThan(DEADLINE_S * 1000 + 2000);
  });

  it("声明了 Content-Length 的慢速发送(非 chunked):总时长仍受期限约束", async () => {
    const r = await run("tricklecl");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("等待结果超时");
    expect(r.ms).toBeLessThan(DEADLINE_S * 1000 + 2000);
  });

  it("一直 done:false:到期限结束", async () => {
    const r = await run("pending");
    expect(r.stderr).toContain("等待结果超时");
    expect(r.ms).toBeLessThan(DEADLINE_S * 1000 + 2000);
  });

  it("提交被拒(400):带状态码报错,不进入轮询", async () => {
    const r = await run("reject");
    expect(r.stderr).toContain("提交失败 HTTP 400");
    expect(hits["reject:result"]).toBeUndefined();
  });

  it("正常完成:输出结果并以 0 退出", async () => {
    const r = await run("ok");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
  });
});

// Python 示例:需要 python3 与 requests;缺任一则跳过
const hasPythonRequests = (() => {
  try {
    execFileSync("python3", ["-c", "import requests"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPythonRequests)("Python 示例:真实网络下的结束行为", () => {
  const run = (mode: Mode) => {
    const file = path.join(outDir, `${mode}.py`);
    fs.writeFileSync(file, snippetFor(mode).python);
    return runFile("python3", file);
  };

  it("受理成功、轮询返回 401:RuntimeError 带状态码,不是 KeyError", async () => {
    const r = await run("unauth");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("RuntimeError: 查询结果失败 HTTP 401");
    expect(r.stderr).not.toContain("KeyError");
  });

  it("受理成功、下一次请求不返回:按期限抛 TimeoutError", async () => {
    const r = await run("hang");
    expect(r.stderr).toContain("TimeoutError: 等待结果超时");
    expect(r.ms).toBeLessThan(DEADLINE_S * 1000 + 2000);
  });

  it("响应头到了但 body 不结束:按期限抛 TimeoutError", async () => {
    const r = await run("stall");
    expect(r.stderr).toContain("TimeoutError: 等待结果超时");
    expect(r.ms).toBeLessThan(DEADLINE_S * 1000 + 2000);
  });

  it("服务端持续慢速发送、永不结束:总时长仍受期限约束", async () => {
    const r = await run("trickle");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("等待结果超时");
    expect(r.ms).toBeLessThan(DEADLINE_S * 1000 + 2000);
  });

  it("声明了 Content-Length 的慢速发送(非 chunked):总时长仍受期限约束", async () => {
    const r = await run("tricklecl");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("等待结果超时");
    expect(r.ms).toBeLessThan(DEADLINE_S * 1000 + 2000);
  });

  it("一直 done:false:到期限抛 TimeoutError", async () => {
    const r = await run("pending");
    expect(r.stderr).toContain("TimeoutError: 等待结果超时");
  });

  it("正常完成:输出结果并以 0 退出", async () => {
    const r = await run("ok");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
  });
});
