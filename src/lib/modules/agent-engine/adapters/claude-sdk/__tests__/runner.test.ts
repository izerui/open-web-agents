// 回放测试:喂录制的 SDK 消息序列,断言事件流与最终结果。不碰网络、不调模型。

import {
  ClaudeSdkEngine,
  type QueryFn,
  combineResults,
} from "@/lib/modules/agent-engine/adapters/claude-sdk/runner";
import type { RunResult } from "@/lib/modules/agent-engine/ports";
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
  model: { ref: "sonnet", modelId: "model-sonnet" },
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
    hostHome: "/Users/operator",
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
    expect(r.cost).toEqual({
      usd: 0.01,
      input: 20,
      output: 8,
      metering: {
        source: "sdk_model_usage",
        complete: false,
        models: [],
        unattributed: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
        fromResultUsage: true,
      },
    });
  });

  it("记下本轮主线消息的首尾 uuid:子代理的、没有 uuid 的不算", async () => {
    const r = await engine(
      replay([
        { type: "system", subtype: "init", session_id: "s", uuid: "sys-1" },
        { type: "assistant", uuid: "a-1", message: { content: [{ type: "text", text: "x" }] } },
        {
          type: "assistant",
          uuid: "sub-1",
          parent_tool_use_id: "tu_9",
          message: { content: [{ type: "text", text: "子代理" }] },
        },
        { type: "user", uuid: "u-2", message: { content: [] } },
        { type: "assistant", message: { content: [{ type: "text", text: "没 uuid" }] } },
        {
          type: "assistant",
          uuid: "sub-2",
          parent_tool_use_id: "tu_9",
          message: { content: [] },
        },
        { type: "result", subtype: "success", result: "ok", uuid: "res-1" },
      ]),
    ).run(spec(), ctx, () => {}, new AbortController().signal);
    expect(r.transcriptRange).toEqual({ first: "a-1", last: "u-2" });
  });

  it("中途失败也带上已产生的范围(历史回放仍要截得出这一段)", async () => {
    const r = await engine(
      replay([
        { type: "system", subtype: "init", session_id: "s" },
        { type: "assistant", uuid: "a-1", message: { content: [] } },
      ]),
    ).run(spec(), ctx, () => {}, new AbortController().signal);
    expect(r.status).toBe("failed");
    expect(r.transcriptRange).toEqual({ first: "a-1", last: "a-1" });
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

  it("没等到结算就结束:按已收到的消息报部分花费,同一条消息不重复计", async () => {
    const msg = (id: string, input: number, output: number) => ({
      type: "assistant",
      message: {
        id,
        content: [{ type: "text", text: "x" }],
        usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 10 },
      },
    });
    const r = await engine(replay([msg("m1", 100, 5), msg("m1", 100, 20), msg("m2", 200, 30)])).run(
      spec(),
      ctx,
      () => {},
      new AbortController().signal,
    );
    expect(r.status).toBe("failed");
    // m1 取最后一次(110 入 / 20 出),m2(210 入 / 30 出);缓存读计入输入总数。
    // 这些消息没带模型标识:按模型的明细为空,用量按四项分开记为未归属(结算按主模型价计)
    expect(r.cost).toEqual({
      input: 320,
      output: 50,
      partial: true,
      metering: {
        source: "sdk_model_usage",
        complete: false,
        partial: true,
        models: [],
        unattributed: {
          inputTokens: 300,
          outputTokens: 50,
          cacheReadTokens: 20,
          cacheWriteTokens: 0,
        },
      },
    });
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
    expect(r.cost).toEqual({
      usd: 0.42,
      input: 900,
      output: 120,
      metering: {
        source: "sdk_model_usage",
        complete: false,
        models: [],
        unattributed: {
          inputTokens: 900,
          outputTokens: 120,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        fromResultUsage: true,
      },
    }); // 钱不能丢
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

  it("通用智能体(无 schema)只回文本也算成功", async () => {
    const r = await engine(
      replay([{ type: "result", subtype: "success", result: "文本而已" }]),
    ).run(spec(), ctx, () => {}, new AbortController().signal);
    expect(r.status).toBe("success");
    expect(r.summary).toBe("文本而已");
  });

  // ─────────────────────────── 流式增量(stream_event) ───────────────────────────
  //
  // SDK 的 query() 在产出完整 assistant 消息之前,会先 yield 一系列 stream_event,
  // 每条包含一个 content_block_delta(text_delta / thinking_delta)。
  // runner 应该:
  //   1. 把 text_delta / thinking_delta 实时翻成 kind:"text" / kind:"thinking" 推出去
  //   2. 完整 assistant 消息到来时跳过 text/thinking(避免重复),但保留 tool_use / usage

  /** 模拟 SDK 的真实流式消息序列:先 stream_event 逐 token,再完整 assistant。 */
  const STREAMING_SEQ = [
    { type: "system", subtype: "init", session_id: "s_stream" },
    // 逐 token 的 text delta
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "你" } },
    },
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "好" } },
    },
    {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "世界" } },
    },
    // 完整 assistant 消息(text 应被跳过,tool_use 和 usage 要保留)
    {
      type: "assistant",
      message: {
        id: "msg_1",
        content: [
          { type: "text", text: "你好世界" },
          { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "echo hi" } },
        ],
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "hi" }] },
    },
    { type: "result", subtype: "success", result: "done" },
  ];

  it("流式:text_delta 逐 token 产出,完整 assistant 不重复 text", async () => {
    const events: AgentEvent[] = [];
    await engine(replay(STREAMING_SEQ)).run(
      spec(),
      ctx,
      (e) => events.push(e),
      new AbortController().signal,
    );

    const kinds = events.map((e) => e.kind);
    // 3 个流式 text + tool_use + usage + tool_result,完整 assistant 的 text 被跳过
    expect(kinds).toEqual(["text", "text", "text", "tool_use", "usage", "tool_result"]);

    // 文本内容是增量的
    const texts = events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["你", "好", "世界"]);
    expect(texts.join("")).toBe("你好世界");
  });

  it("无 stream_event 时退化为原有行为(不跳过 text)", async () => {
    const events: AgentEvent[] = [];
    await engine(replay(RECORDED)).run(
      spec(),
      ctx,
      (e) => events.push(e),
      new AbortController().signal,
    );
    // 没有 stream_event → hasStreamed=false → text 从完整 assistant 消息正常产出
    expect(events.map((e) => e.kind)).toEqual(["text", "tool_use", "tool_result"]);
    expect((events[0] as { text: string }).text).toBe("我先看下目录");
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

describe("ClaudeSdkEngine 用量未知与收尾故障", () => {
  const signal = () => new AbortController().signal;

  it("SDK 抛错且一条用量都没收到 → 标 usageUnknown(可能已调用模型,不能当零用量)", async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s" };
        throw new Error("socket hang up");
      })();
    const r = await engine(q).run(spec(), ctx, () => {}, signal());
    expect(r).toMatchObject({ status: "failed", usageUnknown: true });
    expect(r.cost).toBeUndefined();
  });

  it("流结束没有 result 也没有用量 → 标 usageUnknown", async () => {
    const r = await engine(replay([{ type: "system", subtype: "init", session_id: "s" }])).run(
      spec(),
      ctx,
      () => {},
      signal(),
    );
    expect(r).toMatchObject({ status: "failed", usageUnknown: true });
    expect(r.error?.kind).toBe("no_result");
  });

  it("收到过用量再抛错 → 带部分花费,不标 usageUnknown", async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield {
          type: "assistant",
          message: {
            id: "m1",
            content: [{ type: "text", text: "x" }],
            usage: { input_tokens: 50, output_tokens: 5 },
          },
        };
        throw new Error("boom");
      })();
    const r = await engine(q).run(spec(), ctx, () => {}, signal());
    expect(r.cost).toMatchObject({ input: 50, output: 5, partial: true });
    expect(r.usageUnknown).toBeUndefined();
  });

  it("SDK 已给出非零费用的 result、追加消息收尾抛错 → 结果与花费照常返回", async () => {
    const steer = {
      next: () => new Promise<never>(() => {}),
      delivered: async () => {},
      close: async () => {},
      abandon: async () => {
        throw new Error("redis gone");
      },
    };
    const q: QueryFn = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s" };
        yield {
          type: "result",
          subtype: "success",
          result: "完成",
          total_cost_usd: 0.2,
          usage: { input_tokens: 20000, output_tokens: 1000 },
          modelUsage: {
            "up-main": {
              inputTokens: 20000,
              outputTokens: 1000,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
        };
      })();
    const r = await engine(q).run(spec(), { ...ctx, steer }, () => {}, signal());
    expect(r.status).toBe("success");
    expect(r.cost?.metering?.models).toEqual([
      expect.objectContaining({ modelId: "up-main", inputTokens: 20000, outputTokens: 1000 }),
    ]);
    expect(r.usageUnknown).toBeUndefined();
  });
});

describe("ClaudeSdkEngine 部分计量(按模型)", () => {
  const signal = () => new AbortController().signal;
  const assistant = (id: string, model: string | undefined, input: number, output: number) => ({
    type: "assistant",
    message: {
      id,
      ...(model ? { model } : {}),
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: input, output_tokens: output },
    },
  });
  const result1 = {
    type: "result",
    subtype: "success",
    result: "第一轮",
    total_cost_usd: 0.2,
    usage: { input_tokens: 20000, output_tokens: 1000 },
    modelUsage: {
      "up-main": {
        inputTokens: 20000,
        outputTokens: 1000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  };

  it("取消前已收到非零 usage、没有 result:按消息的模型标识给出可计价的部分计量", async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield assistant("m1", "up-main", 15000, 200);
        yield assistant("m1", "up-main", 15000, 800); // 同一条消息再到一次,取最后一份
        yield assistant("m2", "up-sub", 5000, 200);
        throw new Error("aborted by user");
      })();
    const r = await engine(q).run(spec(), ctx, () => {}, signal());
    expect(r.status).toBe("failed");
    expect(r.usageUnknown).toBeUndefined();
    expect(r.cost?.metering).toEqual({
      source: "sdk_model_usage",
      complete: true,
      partial: true,
      models: [
        {
          modelId: "up-main",
          inputTokens: 15000,
          outputTokens: 800,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        {
          modelId: "up-sub",
          inputTokens: 5000,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });
  });

  it("带模型名的消息 → 不带模型名的消息 → 中断:后者单独记为未归属用量,不丢、不并入已知模型", async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield assistant("m1", "up-main", 10000, 0);
        yield {
          type: "assistant",
          message: {
            id: "m2",
            content: [{ type: "text", text: "x" }],
            usage: {
              input_tokens: 10000,
              output_tokens: 100,
              cache_read_input_tokens: 4000,
              cache_creation_input_tokens: 2000,
            },
          },
        };
        throw new Error("aborted by user");
      })();
    const r = await engine(q).run(spec(), ctx, () => {}, signal());
    expect(r.cost?.metering).toEqual({
      source: "sdk_model_usage",
      complete: false,
      partial: true,
      models: [
        {
          modelId: "up-main",
          inputTokens: 10000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
      unattributed: {
        inputTokens: 10000,
        outputTokens: 100,
        cacheReadTokens: 4000,
        cacheWriteTokens: 2000,
      },
    });
  });

  it("result 没有按模型的明细 → 追加轮带模型名的用量 → 中断:result 的总数记为未归属,不被后来的明细盖掉", async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield { ...result1, modelUsage: undefined };
        yield assistant("m2", "up-main", 10000, 0);
        throw new Error("socket hang up");
      })();
    const r = await engine(q).run(spec(), ctx, () => {}, signal());
    expect(r.cost?.metering).toMatchObject({
      complete: false,
      models: [{ modelId: "up-main", inputTokens: 10000, outputTokens: 0 }],
      unattributed: {
        inputTokens: 20000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
  });

  it("按消息累计时计数读不出:记计量缺失;同一条消息后来那份读得出就撤掉;省略的缓存项不算异常", async () => {
    const msg = (id: string, usage: Record<string, unknown>) => ({
      type: "assistant",
      message: { id, model: "up-main", content: [{ type: "text", text: "x" }], usage },
    });
    const q: QueryFn = () =>
      (async function* () {
        yield msg("m1", { input_tokens: 10000, output_tokens: "lots" });
        yield msg("m1", { input_tokens: 10000, output_tokens: 50 }); // 同一条消息:读出来了
        yield msg("m2", { input_tokens: 5000, output_tokens: -1 }); // 一直读不出
        yield msg("m2", { input_tokens: 5000 }); // 省略输出:没有新信息,不撤销缺失
        throw new Error("aborted by user");
      })();
    const r = await engine(q).run(spec(), ctx, () => {}, signal());
    expect(r.cost?.metering).toEqual({
      source: "sdk_model_usage",
      complete: false,
      partial: true,
      missing: 1,
      models: [
        {
          modelId: "up-main",
          inputTokens: 15000,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });
  });

  it("result 没带计量:之前按消息观察到的用量记进这条结果;多条这样的 result 按模型逐条相加;之后的累计快照仍覆盖、不重复", async () => {
    const bare = { type: "result", subtype: "error_during_execution", result: "出错" };
    const twoBare: QueryFn = () =>
      (async function* () {
        yield assistant("m1", "up-main", 10000, 0);
        yield bare;
        yield assistant("m2", "up-main", 5000, 0);
        yield bare;
      })();
    const r = await engine(twoBare).run(spec(), ctx, () => {}, signal());
    expect(r.cost?.metering).toMatchObject({
      complete: false,
      models: [{ modelId: "up-main", inputTokens: 15000, outputTokens: 0 }],
    });

    const thenSnapshot: QueryFn = () =>
      (async function* () {
        yield assistant("m1", "up-main", 20000, 1000);
        yield bare;
        yield assistant("m2", "up-main", 10000, 0);
        // 累计快照:已含前面两段,沿用它而不再相加
        yield {
          ...result1,
          usage: { input_tokens: 30000, output_tokens: 1000 },
          modelUsage: {
            "up-main": {
              inputTokens: 30000,
              outputTokens: 1000,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
        };
      })();
    const r2 = await engine(thenSnapshot).run(spec(), ctx, () => {}, signal());
    expect(r2.cost?.metering).toMatchObject({
      complete: true,
      models: [{ modelId: "up-main", inputTokens: 30000, outputTokens: 1000 }],
    });
  });

  it("result 的 usage 全是 0 不算计量依据:按消息观察到的非零用量不被它抹掉", async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield assistant("m1", "up-main", 10000, 0);
        yield {
          type: "result",
          subtype: "error_during_execution",
          result: "出错",
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      })();
    const r = await engine(q).run(spec(), ctx, () => {}, signal());
    expect(r.cost?.metering).toMatchObject({
      complete: false,
      models: [{ modelId: "up-main", inputTokens: 10000 }],
    });
  });

  it("result 带了非零 usage(没有 modelUsage):以它为准,不再叠加按消息观察到的", async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield assistant("m1", "up-main", 10000, 0);
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          usage: { input_tokens: 10000, output_tokens: 0 },
        };
      })();
    const r = await engine(q).run(spec(), ctx, () => {}, signal());
    expect(r.cost?.metering).toMatchObject({
      models: [],
      unattributed: { inputTokens: 10000, outputTokens: 0 },
      fromResultUsage: true,
    });
  });

  it("只收到流式事件(完整消息还没到)就中断:message_start / message_delta 也计入", async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield {
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              id: "m1",
              model: "up-main",
              usage: { input_tokens: 12000, output_tokens: 1 },
            },
          },
        };
        yield {
          type: "stream_event",
          event: { type: "message_delta", usage: { output_tokens: 300 } },
        };
        throw new Error("aborted");
      })();
    const r = await engine(q).run(spec(), ctx, () => {}, signal());
    expect(r.cost?.metering?.models).toEqual([
      {
        modelId: "up-main",
        inputTokens: 12000,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
  });

  it("result₁ → 追加轮 usage₂ → 抛错:失败,花费 = result₁ 的累计快照 + 第二轮部分用量,第一轮不重复", async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield assistant("m1", "up-main", 20000, 1000); // 已被 result₁ 覆盖
        yield result1;
        yield assistant("m2", "up-main", 10000, 0);
        throw new Error("socket hang up");
      })();
    const r = await engine(q).run(
      spec({ outputSchema: { type: "object" } }),
      ctx,
      () => {},
      signal(),
    );
    expect(r.status).toBe("failed");
    expect(r.structured).toBeUndefined();
    expect(r.error?.kind).toBe("engine_error");
    expect(r.cost?.metering).toMatchObject({
      complete: true,
      partial: true,
      models: [{ modelId: "up-main", inputTokens: 30000, outputTokens: 1000 }],
    });
  });

  it("result 之后没有新的用量再抛错:仍是那份结果(SDK 在 error result 之后还会再抛一次)", async () => {
    const q: QueryFn = () =>
      (async function* () {
        yield result1;
        throw new Error("exit code 1");
      })();
    const r = await engine(q).run(spec(), ctx, () => {}, signal());
    expect(r.status).toBe("success");
    expect(r.cost?.metering?.partial).toBeUndefined();
  });
});

describe("ClaudeSdkEngine 运行中的累计费用快照", () => {
  const assistant = (id: string, input: number, output: number) => ({
    type: "assistant",
    message: {
      id,
      model: "up-main",
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: input, output_tokens: output },
    },
  });
  const result1 = {
    type: "result",
    subtype: "success",
    result: "第一轮",
    total_cost_usd: 0.2,
    usage: { input_tokens: 20000, output_tokens: 1000 },
    modelUsage: {
      "up-main": {
        inputTokens: 20000,
        outputTokens: 1000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  };
  type Snap = { metering?: { models: { inputTokens: number; outputTokens: number }[] } };
  const tokens = (c: unknown) =>
    ((c as Snap).metering?.models ?? []).map((m) => [m.inputTokens, m.outputTokens]);

  it("每次用量变化交出累计快照;多轮不重复计第一轮;最后一份等于中断时的结算费用", async () => {
    const snaps: unknown[] = [];
    const q: QueryFn = () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s" };
        yield {
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              id: "m1",
              model: "up-main",
              usage: { input_tokens: 20000, output_tokens: 1 },
            },
          },
        };
        yield assistant("m1", 20000, 1000);
        yield result1;
        yield assistant("m2", 10000, 0);
        throw new Error("socket hang up");
      })();
    const r = await engine(q).run(
      spec(),
      { ...ctx, onCostSnapshot: (c) => snaps.push(structuredClone(c)) },
      () => {},
      new AbortController().signal,
    );
    expect(snaps.map(tokens)).toEqual([
      [[20000, 1]], // 流式开始:输入已知
      [[20000, 1000]], // 完整消息
      [[20000, 1000]], // 结算消息:累计快照,不重复
      [[30000, 1000]], // 追加轮:第一轮 + 第二轮
    ]);
    expect(snaps.at(-1)).toEqual(r.cost);
  });

  it("回调抛错不影响运行", async () => {
    const r = await engine(replay([assistant("m1", 1, 1), result1])).run(
      spec(),
      {
        ...ctx,
        onCostSnapshot: () => {
          throw new Error("db down");
        },
      },
      () => {},
      new AbortController().signal,
    );
    expect(r.status).toBe("success");
  });
});

describe("combineResults:多条 result 的计量", () => {
  const withModels = (input: number): RunResult => ({
    status: "success",
    cost: {
      input,
      output: 0,
      metering: {
        source: "sdk_model_usage",
        complete: true,
        models: [
          {
            modelId: "up-main",
            inputTokens: input,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        ],
      },
    },
  });
  const noModels = (cacheRead: number): RunResult => ({
    status: "success",
    cost: {
      input: 0,
      output: 0,
      metering: {
        source: "sdk_model_usage",
        complete: false,
        models: [],
        unattributed: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: 0,
        },
        fromResultUsage: true,
      },
    },
  });

  it("最后一条带明细:它是累计快照,原样沿用,前面的不重复累计", () => {
    const last = withModels(300);
    expect(combineResults([withModels(100), noModels(50), last])?.cost?.metering).toBe(
      last.cost?.metering,
    );
  });

  it("带明细的之后还有没明细的:沿用那份明细,之后各条的未归属用量逐条相加", () => {
    expect(
      combineResults([noModels(7), withModels(100), noModels(50), noModels(20)])?.cost?.metering,
    ).toEqual({
      source: "sdk_model_usage",
      complete: false,
      models: [
        {
          modelId: "up-main",
          inputTokens: 100,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
      unattributed: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 70, cacheWriteTokens: 0 },
    });
  });

  it("都没有明细:未归属用量全部相加", () => {
    expect(combineResults([noModels(10), noModels(20)])?.cost?.metering?.unattributed).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
    });
  });
});
