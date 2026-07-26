import { foldEvents, sumUsage } from "@/features/workbench/conversation";
import type { AgentEvent } from "@/lib/shared";
import { describe, expect, it } from "vitest";

describe("foldEvents", () => {
  it("把 tool_result 合并进对应的 tool_use", () => {
    const out = foldEvents([
      { kind: "tool_use", tool: "Bash", input: { command: "ls" }, toolUseId: "t1" },
      { kind: "tool_result", toolUseId: "t1", text: "a.txt" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "tool", tool: "Bash" });
    expect((out[0] as { result?: { text: string } }).result?.text).toBe("a.txt");
  });

  it("多个工具调用各自配对,不串味", () => {
    const out = foldEvents([
      { kind: "tool_use", tool: "A", input: {}, toolUseId: "t1" },
      { kind: "tool_use", tool: "B", input: {}, toolUseId: "t2" },
      { kind: "tool_result", toolUseId: "t2", text: "B 的结果" },
      { kind: "tool_result", toolUseId: "t1", text: "A 的结果" },
    ]);
    expect(out).toHaveLength(2);
    expect((out[0] as { result?: { text: string } }).result?.text).toBe("A 的结果");
    expect((out[1] as { result?: { text: string } }).result?.text).toBe("B 的结果");
  });

  it("透传错误标记", () => {
    const out = foldEvents([
      { kind: "tool_use", tool: "Bash", input: {}, toolUseId: "t1" },
      { kind: "tool_result", toolUseId: "t1", text: "boom", isError: true },
    ]);
    expect((out[0] as { result?: { isError: boolean } }).result?.isError).toBe(true);
  });

  it("孤儿 tool_result(没有配对的调用)仍然显示,不吞掉", () => {
    const out = foldEvents([{ kind: "tool_result", toolUseId: "unknown", text: "孤儿" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "event" });
  });

  it("usage 事件不进正文(在页脚汇总)", () => {
    const out = foldEvents([
      { kind: "text", text: "hi" },
      { kind: "usage", input: 10, output: 5 },
    ]);
    expect(out).toHaveLength(1);
  });

  it("保留文本与结果事件的顺序", () => {
    const out = foldEvents([
      { kind: "text", text: "先说" },
      { kind: "tool_use", tool: "X", input: {}, toolUseId: "t" },
      { kind: "tool_result", toolUseId: "t", text: "r" },
      { kind: "result", status: "success", summary: "好了" },
    ]);
    expect(out.map((i) => (i.kind === "tool" ? "tool" : i.event.kind))).toEqual([
      "text",
      "tool",
      "result",
    ]);
  });

  it("保留子代理归属", () => {
    const out = foldEvents([
      { kind: "tool_use", tool: "X", input: {}, toolUseId: "t", subagent: "reviewer" },
    ]);
    expect((out[0] as { subagent?: string }).subagent).toBe("reviewer");
  });
});

describe("sumUsage", () => {
  it("同一 messageId 只取最新一份,避免流式重复上报被双算", () => {
    const events: AgentEvent[] = [
      { kind: "usage", messageId: "m1", input: 100, output: 0 },
      { kind: "usage", messageId: "m1", input: 100, output: 50 },
    ];
    expect(sumUsage(events)).toEqual({ input: 100, output: 50 });
  });

  it("不同消息相加", () => {
    expect(
      sumUsage([
        { kind: "usage", messageId: "m1", input: 10, output: 1 },
        { kind: "usage", messageId: "m2", input: 20, output: 2 },
      ]),
    ).toEqual({ input: 30, output: 3 });
  });

  it("无 messageId 的用量直接累加", () => {
    expect(
      sumUsage([
        { kind: "usage", input: 5, output: 1 },
        { kind: "usage", input: 5, output: 1 },
      ]),
    ).toEqual({ input: 10, output: 2 });
  });

  it("没有用量事件时为零", () => {
    expect(sumUsage([{ kind: "text", text: "hi" }])).toEqual({ input: 0, output: 0 });
  });
});
