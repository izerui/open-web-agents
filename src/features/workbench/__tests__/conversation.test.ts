import {
  contextTokens,
  foldEvents,
  formatTokens,
  processBlocks,
  scrollModeForDistance,
  sumUsage,
  transitionScrollMode,
} from "@/features/workbench/conversation";
import type { Turn } from "@/features/workbench/types";
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

  it("合并没有 subagent 字段的连续流式文本", () => {
    const out = foldEvents([
      { kind: "text", text: "已创建 `" },
      { kind: "text", text: "hello.py" },
      { kind: "text", text: "`。" },
    ]);
    expect(out).toEqual([{ kind: "event", event: { kind: "text", text: "已创建 `hello.py`。" } }]);
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

  it("保留过程顺序,只合并相邻工具调用", () => {
    const blocks = processBlocks(
      foldEvents([
        { kind: "thinking", text: "先判断" },
        { kind: "tool_use", tool: "Bash", input: { command: "ls" }, toolUseId: "t1" },
        { kind: "tool_result", toolUseId: "t1", text: "a" },
        { kind: "thinking", text: "再判断" },
        { kind: "tool_use", tool: "Read", input: { file: "a" }, toolUseId: "t2" },
      ]),
    );
    expect(blocks.map((block) => block.kind)).toEqual(["activity"]);
    expect(blocks[0]).toMatchObject({
      kind: "activity",
      items: [
        { kind: "thinking", text: "先判断" },
        { kind: "tool", call: { tool: "Bash" } },
        { kind: "thinking", text: "再判断" },
        { kind: "tool", call: { tool: "Read" } },
      ],
    });
  });

  it("过滤瞬时状态,保留诊断状态和孤立工具结果", () => {
    const blocks = processBlocks(
      foldEvents([
        { kind: "status", label: "已入队", state: "pending" },
        { kind: "status", label: "运行中", state: "running" },
        { kind: "status", label: "已引用知识库资料", state: "knowledge" },
        { kind: "tool_result", toolUseId: "missing", text: "orphan", isError: true },
      ]),
    );
    expect(blocks).toEqual([
      { kind: "status", label: "已引用知识库资料", state: "knowledge" },
      { kind: "tool-result", text: "orphan", isError: true },
    ]);
  });

  it("保留子代理归属", () => {
    const out = foldEvents([
      { kind: "tool_use", tool: "X", input: {}, toolUseId: "t", subagent: "reviewer" },
    ]);
    expect((out[0] as { subagent?: string }).subagent).toBe("reviewer");
  });
});

describe("scrollModeForDistance", () => {
  it("在底部跟随,离开底部后进入锚定或自由浏览", () => {
    expect(scrollModeForDistance(20)).toBe("following");
    expect(scrollModeForDistance(120)).toBe("anchoring");
    expect(scrollModeForDistance(500)).toBe("free");
  });
});

describe("transitionScrollMode", () => {
  it("新轮次从跟随模式进入锚定,不会打断自由浏览", () => {
    expect(transitionScrollMode("following", { kind: "new-turn" })).toBe("anchoring");
    expect(transitionScrollMode("free", { kind: "new-turn" })).toBe("free");
  });

  it("用户主动导航进入自由模式,回到底部恢复跟随", () => {
    expect(transitionScrollMode("anchoring", { kind: "user-navigation" })).toBe("free");
    expect(transitionScrollMode("free", { kind: "distance-change", distanceFromEnd: 20 })).toBe(
      "following",
    );
  });

  it("锚定中的运行结束后保持当前位置,除非已经回到底部", () => {
    expect(transitionScrollMode("anchoring", { kind: "run-ended", distanceFromEnd: 200 })).toBe(
      "free",
    );
    expect(transitionScrollMode("anchoring", { kind: "run-ended", distanceFromEnd: 20 })).toBe(
      "following",
    );
  });
});

describe("sumUsage", () => {
  it("同一 messageId 只取最新一份,避免流式重复上报被双算", () => {
    const events: AgentEvent[] = [
      { kind: "usage", messageId: "m1", input: 100, output: 0 },
      {
        kind: "usage",
        messageId: "m1",
        input: 100,
        output: 50,
        cacheRead: 20,
        cacheCreation: 10,
      },
    ];
    expect(sumUsage(events)).toEqual({
      input: 100,
      output: 50,
      cacheRead: 20,
      cacheCreation: 10,
    });
  });

  it("不同消息相加", () => {
    expect(
      sumUsage([
        { kind: "usage", messageId: "m1", input: 10, output: 1 },
        { kind: "usage", messageId: "m2", input: 20, output: 2 },
      ]),
    ).toEqual({ input: 30, output: 3, cacheRead: 0, cacheCreation: 0 });
  });

  it("无 messageId 的用量直接累加", () => {
    expect(
      sumUsage([
        { kind: "usage", input: 5, output: 1 },
        { kind: "usage", input: 5, output: 1 },
      ]),
    ).toEqual({ input: 10, output: 2, cacheRead: 0, cacheCreation: 0 });
  });

  it("没有用量事件时为零", () => {
    expect(sumUsage([{ kind: "text", text: "hi" }])).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });
  });
});

describe("formatTokens", () => {
  it("四位数以下原样显示", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("千位用 K,百万用 M", () => {
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(45231)).toBe("45.2K");
    expect(formatTokens(1_000_000)).toBe("1.00M");
    expect(formatTokens(1_234_567)).toBe("1.23M");
  });
});

describe("contextTokens", () => {
  const turnWith = (input: number, output = 0): Turn => ({
    prompt: "p",
    running: false,
    events: input > 0 || output > 0 ? [{ kind: "usage", input, output }] : [],
  });

  it("取最后一轮的 input,而不是各轮累加", () => {
    // 每轮 input 都含全部历史,累加会得到 300 —— 那是计费总量,不是上下文占用
    const turns = [turnWith(50), turnWith(100), turnWith(150)];
    expect(contextTokens(turns)).toBe(150);
  });

  it("最后一轮还没有用量时往前找,避免数字突然归零", () => {
    const turns = [turnWith(120), turnWith(0)];
    expect(contextTokens(turns)).toBe(120);
  });

  it("一轮里多次模型调用:取最后一次,不累加(每次调用都带着完整上下文)", () => {
    const turn: Turn = {
      prompt: "p",
      running: false,
      events: [
        { kind: "usage", messageId: "m1", input: 1000, output: 50, cacheRead: 9000 },
        { kind: "usage", messageId: "m2", input: 1200, output: 80, cacheRead: 9000 },
        { kind: "usage", messageId: "m3", input: 1500, output: 100, cacheRead: 9000 },
      ],
    };
    // 曾经算成 3 次累加 ≈ 31,930
    expect(contextTokens([turn])).toBe(1500 + 9000 + 100);
  });

  it("一轮用量都没有时返回 0", () => {
    expect(contextTokens([turnWith(0)])).toBe(0);
    expect(contextTokens([])).toBe(0);
  });
});
