// 录制回放测试:断言真实 SDK 消息结构 → 域事件的翻译。
// SDK 升级时先跑本文件 —— 它是归一层作为「唯一缓冲」的守护网。

import {
  createSubagentLabeler,
  normalizeSdkMessage,
  normalizeStreamEvent,
  shortSubagentId,
} from "@/lib/modules/agent-engine/domain/normalize";
import { type AgentEvent, isStateEvent } from "@/lib/shared";
import { describe, expect, it } from "vitest";

describe("normalizeSdkMessage / assistant", () => {
  it("text 块 → text 事件", () => {
    expect(
      normalizeSdkMessage({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "hi" }] },
      }),
    ).toEqual([{ kind: "text", text: "hi", subagent: undefined }]);
  });

  it("tool_use 块 → tool_use 事件,带 toolUseId 与子代理归属", () => {
    expect(
      normalizeSdkMessage({
        type: "assistant",
        parent_tool_use_id: "sub1",
        message: { content: [{ type: "tool_use", id: "tu_1", name: "render", input: { a: 1 } }] },
      }),
    ).toEqual([
      { kind: "tool_use", tool: "render", input: { a: 1 }, toolUseId: "tu_1", subagent: "sub1" },
    ]);
  });

  it("多块全部保留,不只取第一个", () => {
    expect(
      normalizeSdkMessage({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "text", text: "开始渲染" },
            { type: "tool_use", id: "tu_2", name: "Bash", input: { command: "manim" } },
          ],
        },
      }),
    ).toEqual([
      { kind: "text", text: "开始渲染", subagent: undefined },
      {
        kind: "tool_use",
        tool: "Bash",
        input: { command: "manim" },
        toolUseId: "tu_2",
        subagent: undefined,
      },
    ]);
  });

  it("thinking 块 → thinking 事件", () => {
    expect(
      normalizeSdkMessage({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "thinking", thinking: "先测时长" }] },
      }),
    ).toEqual([{ kind: "thinking", text: "先测时长", subagent: undefined }]);
  });

  it("带 usage → 追加 usage 事件(域内用 input/output 字段名)", () => {
    expect(
      normalizeSdkMessage({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "msg_1",
          content: [{ type: "text", text: "x" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ).toEqual([
      { kind: "text", text: "x", subagent: undefined },
      { kind: "usage", messageId: "msg_1", input: 10, output: 5 },
    ]);
  });

  it("未知块类型被忽略", () => {
    expect(
      normalizeSdkMessage({
        type: "assistant",
        message: { content: [{ type: "image", source: {} }] },
      }),
    ).toEqual([]);
  });

  it("content 非数组时安全返回 []", () => {
    expect(normalizeSdkMessage({ type: "assistant", message: {} })).toEqual([]);
  });
});

describe("normalizeSdkMessage / user", () => {
  it("字符串 content 的 tool_result", () => {
    expect(
      normalizeSdkMessage({
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "done", is_error: false }],
        },
      }),
    ).toEqual([
      { kind: "tool_result", toolUseId: "tu_1", text: "done", isError: false, subagent: undefined },
    ]);
  });

  it("块数组 content 抽成文本,is_error 透传", () => {
    expect(
      normalizeSdkMessage({
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_9",
              content: [{ type: "text", text: "boom" }],
              is_error: true,
            },
          ],
        },
      }),
    ).toEqual([
      { kind: "tool_result", toolUseId: "tu_9", text: "boom", isError: true, subagent: undefined },
    ]);
  });

  it("超长 tool_result 被截断", () => {
    const long = "x".repeat(5000);
    const out = normalizeSdkMessage({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t", content: long }] },
    }) as Array<{ text: string }>;
    expect(out[0]?.text.length).toBeLessThan(long.length);
    expect(out[0]?.text).toContain("已截断");
  });

  // thinking 与 tool_result 都截了,唯独 text 没有 —— 而它恰恰是量最大的那类。
  // agent 内联输出大文件内容时,无界字符串被 JSON 序列化后经总线推出
  // (publish 只有 2 秒超时、没有尺寸上限),并进入每个重连客户端的内存重放缓冲。
  // 文件头声明的"避免撑爆 SSE 与 UI"在最需要它的那一类上静默失效。
  it("【截断回归】超长 text 同样被截断", () => {
    const long = "x".repeat(50_000);
    const out = normalizeSdkMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: long }] },
    }) as Array<{ text: string }>;
    expect(out[0]?.text.length).toBeLessThan(long.length);
    expect(out[0]?.text).toContain("已截断");
  });

  it("超长 thinking 被截断", () => {
    const long = "y".repeat(50_000);
    const out = normalizeSdkMessage({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: long }] },
    }) as Array<{ text: string }>;
    expect(out[0]?.text).toContain("已截断");
  });

  it("正常长度的 text 不受影响", () => {
    const out = normalizeSdkMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "简短回答" }] },
    }) as Array<{ text: string }>;
    expect(out[0]?.text).toBe("简短回答");
  });
});

describe("normalizeSdkMessage / 脱敏", () => {
  it("tool_use 入参里的密钥被掩码", () => {
    const out = normalizeSdkMessage({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t", name: "Bash", input: { command: "X_KEY=sk-abcdefgh go" } },
        ],
      },
    }) as Array<{ input: { command: string } }>;
    expect(out[0]?.input.command).toBe("X_KEY=*** go");
  });

  it("tool_result 文本里的密钥被掩码", () => {
    const out = normalizeSdkMessage({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t", content: "leaked sk-abcdefghij" }],
      },
    }) as Array<{ text: string }>;
    expect(out[0]?.text).toBe("leaked sk-***");
  });
});

describe("normalizeSdkMessage / 非事件消息", () => {
  it("system / result / stream_event / 未知 / null 都返回 []", () => {
    expect(normalizeSdkMessage({ type: "system", subtype: "init", session_id: "s" })).toEqual([]);
    expect(normalizeSdkMessage({ type: "result", subtype: "success" })).toEqual([]);
    expect(normalizeSdkMessage({ type: "stream_event", event: {} })).toEqual([]);
    expect(normalizeSdkMessage({ type: "whatever" })).toEqual([]);
    expect(normalizeSdkMessage(null)).toEqual([]);
    expect(normalizeSdkMessage("string")).toEqual([]);
  });
});

describe("createSubagentLabeler", () => {
  it("把 Agent 派发的 subagent_type 贴到后续同 id 的事件上", () => {
    const label = createSubagentLabeler();
    label({
      kind: "tool_use",
      tool: "Agent",
      input: { subagent_type: "reviewer" },
      toolUseId: "tu_x",
      subagent: undefined,
    });
    const e = label({ kind: "text", text: "hi", subagent: "tu_x" }) as { subagent?: string };
    expect(e.subagent).toBe("reviewer");
  });

  it("兼容历史别名 Task", () => {
    const label = createSubagentLabeler();
    label({
      kind: "tool_use",
      tool: "Task",
      input: { subagent_type: "legacy" },
      toolUseId: "tu_t",
      subagent: undefined,
    });
    const e = label({ kind: "text", text: "hi", subagent: "tu_t" }) as { subagent?: string };
    expect(e.subagent).toBe("legacy");
  });

  it("拿不到名字时兜底短 id", () => {
    const label = createSubagentLabeler();
    const e = label({ kind: "text", text: "hi", subagent: "toolu_0123456789abcdefdeadbeef" }) as {
      subagent?: string;
    };
    expect(e.subagent).toBe("toolu_01234567");
  });

  it("主 agent 事件(无 subagent)不受影响", () => {
    const label = createSubagentLabeler();
    const e = label({ kind: "text", text: "hi" }) as { subagent?: string };
    expect(e.subagent).toBeUndefined();
  });
});

describe("shortSubagentId", () => {
  it("长 id 截断到 14 字符", () => {
    expect(shortSubagentId("toolu_0123456789abcdef")).toBe("toolu_01234567");
  });
  it("短 id 原样", () => {
    expect(shortSubagentId("sub1")).toBe("sub1");
  });
});

// AskUserQuestion 是"问用户"而不是"做事",不能跟 Read/Bash 一样当普通工具推出去。
//
// 之前它就是一条 tool_use,界面上渲染成一坨 JSON —— 用户根本不知道那是在问自己,
// 而 agent 已经把选项都列好了。SDK 随后回一句 "The user did not answer the questions.",
// agent 只好用纯文本把同一个问题再问一遍,结构化选项白费。
describe("normalizeSdkMessage / AskUserQuestion", () => {
  const ask = (input: unknown) =>
    normalizeSdkMessage({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tu_1", name: "AskUserQuestion", input }],
      },
    }) as AgentEvent[];

  const VALID = {
    questions: [
      {
        header: "行程类型",
        question: "你想规划哪方面的行程?",
        multiSelect: false,
        options: [
          { label: "日常工作/学习", description: "会议、任务、学习" },
          { label: "出行/旅游", description: "出行、游玩、购物" },
        ],
      },
    ],
  };

  it("翻成 question 事件,而不是 tool_use", () => {
    const [e] = ask(VALID);
    expect(e?.kind).toBe("question");
    expect(e?.kind === "question" && e.questions[0]?.options.map((o) => o.label)).toEqual([
      "日常工作/学习",
      "出行/旅游",
    ]);
    expect(e?.kind === "question" && e.toolUseId).toBe("tu_1");
  });

  it("带上 header 与 multiSelect,界面要靠它们决定怎么渲染", () => {
    const [e] = ask({
      questions: [
        { header: "口味", question: "选几个?", multiSelect: true, options: [{ label: "甜" }] },
      ],
    });
    expect(e?.kind === "question" && e.questions[0]?.header).toBe("口味");
    expect(e?.kind === "question" && e.questions[0]?.multiSelect).toBe(true);
  });

  it("multiSelect 缺省时按单选,不能猜成多选", () => {
    const [e] = ask({ questions: [{ question: "q", options: [{ label: "a" }] }] });
    expect(e?.kind === "question" && e.questions[0]?.multiSelect).toBe(false);
  });

  // 形状不合就退回普通 tool_use:难看但信息没丢,
  // 好过渲染出一个点不动的空按钮组让用户干等
  for (const [name, bad] of [
    ["questions 不是数组", { questions: "x" }],
    ["questions 为空", { questions: [] }],
    ["缺 question 文本", { questions: [{ options: [{ label: "a" }] }] }],
    ["缺 options", { questions: [{ question: "q" }] }],
    ["options 里没有可用 label", { questions: [{ question: "q", options: [{ label: "" }] }] }],
    ["入参为 null", null],
  ] as const) {
    it(`形状不合(${name})时退回 tool_use,不丢信息`, () => {
      const [e] = ask(bad);
      expect(e?.kind).toBe("tool_use");
      expect(e?.kind === "tool_use" && e.tool).toBe("AskUserQuestion");
    });
  }

  it("其它工具不受影响", () => {
    const out = normalizeSdkMessage({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "a" } }],
      },
    }) as AgentEvent[];
    expect(out[0]?.kind).toBe("tool_use");
  });

  it("question 属于 state 类事件 —— 断线重连后选项必须还在", () => {
    const [e] = ask(VALID);
    expect(e && isStateEvent(e)).toBe(true);
  });
});

// ─────────────────────────── normalizeStreamEvent ───────────────────────────

describe("normalizeStreamEvent", () => {
  it("text_delta → text 事件(增量文本)", () => {
    expect(
      normalizeStreamEvent({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "你好" },
        },
      }),
    ).toEqual([{ kind: "text", text: "你好", subagent: undefined }]);
  });

  it("thinking_delta → thinking 事件(增量思考)", () => {
    expect(
      normalizeStreamEvent({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "让我想想" },
        },
      }),
    ).toEqual([{ kind: "thinking", text: "让我想想", subagent: undefined }]);
  });

  it("input_json_delta → [](工具入参增量不在此处理)", () => {
    expect(
      normalizeStreamEvent({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '{"com' },
        },
      }),
    ).toEqual([]);
  });

  it("子代理的 stream_event 带 subagent 归属", () => {
    expect(
      normalizeStreamEvent({
        type: "stream_event",
        parent_tool_use_id: "sub_abc",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "子代理输出" },
        },
      }),
    ).toEqual([{ kind: "text", text: "子代理输出", subagent: "sub_abc" }]);
  });

  it("content_block_start / stop / message_start 等不产出事件", () => {
    expect(
      normalizeStreamEvent({
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "text" } },
      }),
    ).toEqual([]);
    expect(
      normalizeStreamEvent({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      }),
    ).toEqual([]);
    expect(
      normalizeStreamEvent({
        type: "stream_event",
        event: { type: "message_start", message: {} },
      }),
    ).toEqual([]);
    expect(
      normalizeStreamEvent({
        type: "stream_event",
        event: { type: "message_delta", delta: {} },
      }),
    ).toEqual([]);
  });

  it("非 stream_event 类型返回 []", () => {
    expect(normalizeStreamEvent({ type: "assistant", message: {} })).toEqual([]);
    expect(normalizeStreamEvent(null)).toEqual([]);
    expect(normalizeStreamEvent("string")).toEqual([]);
  });

  it("event 为空或非对象时安全返回 []", () => {
    expect(normalizeStreamEvent({ type: "stream_event", event: null })).toEqual([]);
    expect(normalizeStreamEvent({ type: "stream_event" })).toEqual([]);
  });
});

// ─────────────────────────── skipStreamed ───────────────────────────

describe("normalizeSdkMessage / skipStreamed", () => {
  const MSG_WITH_ALL = {
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "msg_1",
      content: [
        { type: "text", text: "解释一下" },
        { type: "thinking", thinking: "先分析" },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };

  it("skipStreamed=false(默认):所有块都产出事件", () => {
    const out = normalizeSdkMessage(MSG_WITH_ALL);
    const kinds = out.map((e) => e.kind);
    expect(kinds).toEqual(["text", "thinking", "tool_use", "usage"]);
  });

  it("skipStreamed=true:跳过 text 和 thinking,保留 tool_use 和 usage", () => {
    const out = normalizeSdkMessage(MSG_WITH_ALL, { skipStreamed: true });
    const kinds = out.map((e) => e.kind);
    expect(kinds).toEqual(["tool_use", "usage"]);
  });

  it("skipStreamed=true 时 AskUserQuestion 仍正常翻成 question 事件", () => {
    const out = normalizeSdkMessage(
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "让我问你" },
            {
              type: "tool_use",
              id: "tu_q",
              name: "AskUserQuestion",
              input: {
                questions: [
                  { question: "选哪个?", options: [{ label: "A" }, { label: "B" }] },
                ],
              },
            },
          ],
        },
      },
      { skipStreamed: true },
    ) as AgentEvent[];
    // text 被跳过,只剩 question
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("question");
  });

  it("skipStreamed 不影响 user 消息(tool_result 照常输出)", () => {
    const out = normalizeSdkMessage(
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
        },
      },
      { skipStreamed: true },
    );
    expect(out).toEqual([
      { kind: "tool_result", toolUseId: "tu_1", text: "ok", isError: false, subagent: undefined },
    ]);
  });
});
