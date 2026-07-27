// 回放测试:喂录制的 SDK 消息序列,断言事件流与最终结果。不碰网络、不调模型。

import {
  ClaudeSdkEngine,
  type QueryFn,
} from "@/lib/modules/agent-engine/adapters/claude-sdk/runner";
import type { AgentEvent, AgentSpec, RunContext } from "@/lib/shared";
import { describe, expect, it, vi } from "vitest";

const ctx: RunContext = {
  sessionId: "s1",
  workspaceDir: "/ws/s1",
  prompt: "生成一个视频",
  credentials: { baseUrl: "https://gw", key: "sk-x" },
  env: {},
};

const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({
  systemPrompt: "p",
  model: { alias: "sonnet" },
  limits: {},
  ...over,
});

/** 用录制消息构造一个假的 query。 */
function replay(messages: unknown[]): QueryFn {
  return () =>
    (async function* () {
      for (const m of messages) yield m;
    })();
}

const gateway = {
  slots: () => ({ fable: "m", opus: "m", sonnet: "m-sonnet", haiku: "m" }),
};

const engine = (q: QueryFn) =>
  new ClaudeSdkEngine(q, {
    sharedHome: "/data/.agent-home",
    gateway,
    sandboxEnabled: false,
    allowStdioMcp: false,
  });

const RECORDED = [
  { type: "system", subtype: "init", session_id: "sdk_sess_42" },
  { type: "assistant", message: { content: [{ type: "text", text: "我先看下目录" }] } },
  {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }],
    },
  },
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "a.txt" }] },
  },
  {
    type: "result",
    subtype: "success",
    result: "完成",
    total_cost_usd: 0.01,
    usage: { input_tokens: 20, output_tokens: 8 },
    structured_output: { videoId: "v1" },
  },
];

describe("ClaudeSdkEngine 回放", () => {
  it("完整一轮:事件顺序正确,结果与 sessionId 提取到位", async () => {
    const events: AgentEvent[] = [];
    const r = await engine(replay(RECORDED)).run(
      spec({ outputSchema: { type: "object" } }),
      ctx,
      (e) => events.push(e),
      new AbortController().signal,
    );

    expect(events.map((e) => e.kind)).toEqual(["text", "tool_use", "tool_result"]);
    expect(r.status).toBe("success");
    expect(r.structured).toEqual({ videoId: "v1" });
    expect(r.sessionId).toBe("sdk_sess_42");
    expect(r.cost).toEqual({ usd: 0.01, input: 20, output: 8 });
  });

  it("system/result 消息不进事件流", async () => {
    const events: AgentEvent[] = [];
    await engine(replay(RECORDED)).run(
      spec(),
      ctx,
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(events.some((e) => e.kind === "result")).toBe(false);
  });

  it("prompt 与组装好的 options 正确传给 SDK", async () => {
    const q = vi.fn(replay(RECORDED)) as unknown as QueryFn & { mock: { calls: unknown[][] } };
    await engine(q).run(spec(), ctx, () => {}, new AbortController().signal);

    const arg = (
      q as unknown as { mock: { calls: [{ prompt: string; options: Record<string, unknown> }][] } }
    ).mock.calls[0]?.[0];
    expect(arg?.prompt).toBe("生成一个视频");
    expect(arg?.options.cwd).toBe("/ws/s1");
    expect((arg?.options.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("sk-x");
  });

  it("流里没有 result 消息 → 失败并标 no_result", async () => {
    const r = await engine(replay([{ type: "system", subtype: "init", session_id: "s1" }])).run(
      spec(),
      ctx,
      () => {},
      new AbortController().signal,
    );
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("no_result");
    expect(r.sessionId).toBe("s1");
  });

  it("已中断的 signal → 失败并标 aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await engine(replay([])).run(spec(), ctx, () => {}, ac.signal);
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("aborted");
  });

  it("SDK 抛错 → 失败并带错误信息,不炸穿调用方", async () => {
    const boom: QueryFn = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        throw new Error("sdk exploded");
      })();
    const r = await engine(boom).run(spec(), ctx, () => {}, new AbortController().signal);
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("engine_error");
    expect(r.error?.message).toContain("sdk exploded");
  });

  // 官方文档(cost-tracking.md)原话:"A single-shot query() throws after yielding an
  // error result. If the failure was an error result, it still carried total_cost_usd"
  // —— 也就是说【超轮次/超预算这类失败,是先给 result 再抛异常】。
  // catch 里如果只看异常不看已到手的 result,这些运行花掉的钱就永久统计不到了,
  // 而且真实的失败原因(error_max_turns)会退化成笼统的 engine_error。
  it("先产出 error result 再抛异常 → 保留 result 里的成本与真实错因", async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield {
          type: "result",
          subtype: "error_max_turns",
          result: "达到最大轮次",
          total_cost_usd: 0.42,
          usage: { input_tokens: 900, output_tokens: 120 },
        };
        throw new Error("stream closed after error result");
      })();
    const r = await engine(q).run(spec(), ctx, () => {}, new AbortController().signal);

    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("error_max_turns"); // 不是 engine_error
    expect(r.cost).toEqual({ usd: 0.42, input: 900, output: 120 }); // 钱不能丢
    expect(r.sessionId).toBe("s1");
  });

  it("没拿到 result 就抛异常 → 仍按引擎错误处理", async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        throw new Error("connection reset");
      })();
    const r = await engine(q).run(spec(), ctx, () => {}, new AbortController().signal);
    expect(r.error?.kind).toBe("engine_error");
    expect(r.error?.message).toContain("connection reset");
  });

  it("声明了 schema 却没结构化输出 → 失败(契约缺失)", async () => {
    const r = await engine(
      replay([{ type: "result", subtype: "success", result: "文本而已" }]),
    ).run(spec({ outputSchema: { type: "object" } }), ctx, () => {}, new AbortController().signal);
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("no_structured_output");
  });

  it("通用助手(无 schema)只回文本也算成功", async () => {
    const r = await engine(
      replay([{ type: "result", subtype: "success", result: "文本而已" }]),
    ).run(spec(), ctx, () => {}, new AbortController().signal);
    expect(r.status).toBe("success");
    expect(r.summary).toBe("文本而已");
  });

  it("子代理事件被贴上可读名", async () => {
    const events: AgentEvent[] = [];
    await engine(
      replay([
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "tu_a", name: "Agent", input: { subagent_type: "reviewer" } },
            ],
          },
        },
        {
          type: "assistant",
          parent_tool_use_id: "tu_a",
          message: { content: [{ type: "text", text: "子代理在干活" }] },
        },
        { type: "result", subtype: "success", result: "ok" },
      ]),
    ).run(spec(), ctx, (e) => events.push(e), new AbortController().signal);

    const child = events.find((e) => e.kind === "text") as { subagent?: string };
    expect(child.subagent).toBe("reviewer");
  });
});
