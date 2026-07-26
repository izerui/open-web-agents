// 录制回放测试:断言真实 SDK 消息结构 → 域事件的翻译。
// SDK 升级时先跑本文件 —— 它是归一层作为「唯一缓冲」的守护网。

import {
  createSubagentLabeler,
  normalizeSdkMessage,
  shortSubagentId,
} from "@/lib/modules/agent-engine/domain/normalize";
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
