import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSnippets, sampleFromSchema, sampleInput } from "@/features/integration/snippets";
import { validateInput } from "@/lib/modules/agent/domain/validate-output";
import { describe, expect, it, vi } from "vitest";

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

  it("Python:JSON 布尔值换成 Python 字面量", () => {
    expect(s.python).toContain('"ok": False');
    expect(s.python).toContain('print(res["structured"])');
  });

  it("嵌入片段指向同一个智能体,并检查换令牌的响应状态", () => {
    expect(s.embed).toContain('agentId: "a1"');
    expect(s.embed).toContain("if (!r.ok)");
  });
});

// ── 真正执行生成出来的示例代码 ────────────────────────────────────────────────

const snippets = buildSnippets({
  origin: "https://owa.example.com",
  agentId: "a1",
  inputSchema: {
    type: "object",
    required: ["n"],
    properties: { n: { type: "integer", minimum: 1 } },
  },
  hasOutputSchema: true,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * 把 Node 示例当成一个 async 函数执行,注入假的 fetch / Date / setTimeout。
 * 假 fetch 设了调用上限:示例若失控轮询,测试会以 "runaway polling" 明确失败,而不是卡死。
 */
function runNode(inner: typeof fetch, now: () => number) {
  let n = 0;
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    if (++n > 50) throw new Error("runaway polling");
    return inner(...args);
  }) as typeof fetch;
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction(
    "fetch",
    "process",
    "crypto",
    "setTimeout",
    "console",
    "Date",
    snippets.node,
  );
  return fn(
    fetchImpl,
    { env: { OWA_API_KEY: "k" } },
    { randomUUID: () => "uuid" },
    (cb: () => void) => cb(),
    { log: () => {} },
    { now },
  ) as Promise<void>;
}

describe("Node 示例的执行行为", () => {
  it("受理成功、轮询返回 401(Key 被吊销):立刻明确报错,不再继续请求", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/invoke")
        ? json(202, { taskId: "t1" })
        : json(401, { error: "invalid api key", code: "unauthorized" }),
    );
    await expect(runNode(fetchImpl as unknown as typeof fetch, () => 0)).rejects.toThrow(
      /查询结果失败 HTTP 401/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("任务一直不结束:到整体期限就超时退出", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/invoke")
        ? json(202, { taskId: "t1" })
        : json(200, { done: false, status: "running" }),
    );
    await expect(
      runNode(fetchImpl as unknown as typeof fetch, () => {
        t += 61_000;
        return t;
      }),
    ).rejects.toThrow(/等待结果超时/);
    expect(fetchImpl.mock.calls.length).toBeLessThan(20);
  });

  it("提交被拒(如 400):带状态码报错", async () => {
    const fetchImpl = vi.fn(async () => json(400, { error: "bad", code: "input_invalid" }));
    await expect(runNode(fetchImpl as unknown as typeof fetch, () => 0)).rejects.toThrow(
      /提交失败 HTTP 400/,
    );
  });

  it("正常完成:拿到结果后结束", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/invoke")
        ? json(202, { taskId: "t1" })
        : json(200, { done: true, status: "success", structured: { ok: 1 } }),
    );
    await expect(runNode(fetchImpl as unknown as typeof fetch, () => 0)).resolves.toBeUndefined();
  });
});

// Python 示例:用假的 requests 模块执行一遍。没有 python3 的环境跳过
const hasPython = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const HARNESS = `
import sys, types, json, os, time
calls = []
mode = sys.argv[2]
class Resp:
    def __init__(self, code, body):
        self.status_code = code; self._b = body; self.text = json.dumps(body)
    def json(self): return self._b
def post(url, **kw):
    calls.append(url); return Resp(202, {"taskId": "t1"})
def get(url, **kw):
    calls.append(url)
    if len(calls) > 50: raise SystemError("runaway polling")
    if mode == "401": return Resp(401, {"error": "invalid api key", "code": "unauthorized"})
    return Resp(200, {"done": False, "status": "running"})
sys.modules["requests"] = types.SimpleNamespace(post=post, get=get)
os.environ["OWA_API_KEY"] = "k"
t = [0.0]
def mono():
    t[0] += 61
    return t[0]
time.monotonic = mono
time.sleep = lambda s: None
try:
    exec(compile(open(sys.argv[1]).read(), "snippet", "exec"), {})
    print(json.dumps({"ok": True, "calls": len(calls)}))
except BaseException as e:
    print(json.dumps({"ok": False, "type": type(e).__name__, "msg": str(e), "calls": len(calls)}))
`;

describe.skipIf(!hasPython)("Python 示例的执行行为", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-snippet-"));
  const snippetFile = path.join(dir, "snippet.py");
  const harnessFile = path.join(dir, "harness.py");
  fs.writeFileSync(snippetFile, snippets.python);
  fs.writeFileSync(harnessFile, HARNESS);
  const run = (mode: string) =>
    JSON.parse(execFileSync("python3", [harnessFile, snippetFile, mode], { encoding: "utf8" })) as {
      ok: boolean;
      type?: string;
      msg?: string;
      calls: number;
    };

  it("受理成功、轮询返回 401:明确的 RuntimeError(带状态码),不是 KeyError,也不再轮询", () => {
    const r = run("401");
    expect(r.ok).toBe(false);
    expect(r.type).toBe("RuntimeError");
    expect(r.msg).toContain("HTTP 401");
    expect(r.calls).toBe(2);
  });

  it("任务一直不结束:到整体期限抛 TimeoutError", () => {
    const r = run("pending");
    expect(r.ok).toBe(false);
    expect(r.type).toBe("TimeoutError");
    expect(r.calls).toBeLessThan(20);
  });
});
