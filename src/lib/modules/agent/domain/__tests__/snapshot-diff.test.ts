import { diffSnapshots, lineDiff } from "@/lib/modules/agent/domain/snapshot-diff";
import type { AgentSnapshot } from "@/lib/modules/agent/ports";
import { describe, expect, it } from "vitest";

const base: AgentSnapshot = {
  name: "审查助手",
  config: {
    systemPrompt: "你是审查员。\n逐条检查合同。\n输出 JSON。",
    model: "sonnet",
    subagents: [
      { name: "reviewer", prompt: "审阅", background: false },
      { name: "summarizer", prompt: "汇总", background: false },
    ],
  },
};

describe("diffSnapshots", () => {
  it("没改:空", () => {
    expect(diffSnapshots(base, structuredClone(base))).toEqual([]);
  });

  it("提示词改了一行:给出行级差异,只有那一行是增删", () => {
    const after = structuredClone(base);
    after.config.systemPrompt = "你是审查员。\n逐条检查合同,标出风险。\n输出 JSON。";
    const [c] = diffSnapshots(base, after);
    expect(c).toMatchObject({ path: "config.systemPrompt", kind: "changed" });
    expect(c && "lines" in c ? c.lines : undefined).toEqual([
      { op: "same", text: "你是审查员。" },
      { op: "del", text: "逐条检查合同。" },
      { op: "add", text: "逐条检查合同,标出风险。" },
      { op: "same", text: "输出 JSON。" },
    ]);
  });

  it("带 name 的列表按名字对齐:换顺序不算改动;增、删、改各自报出", () => {
    const reordered = structuredClone(base);
    reordered.config.subagents = [...(base.config.subagents ?? [])].reverse();
    expect(diffSnapshots(base, reordered)).toEqual([]);

    const after = structuredClone(base);
    after.config.subagents = [
      { name: "reviewer", prompt: "审阅", model: "haiku", background: false },
      { name: "translator", prompt: "翻译", background: false },
    ];
    const changes = diffSnapshots(base, after).map((c) => `${c.kind} ${c.path}`);
    expect(changes).toEqual([
      "added config.subagents[reviewer].model",
      "removed config.subagents[summarizer]",
      "added config.subagents[translator]",
    ]);
  });

  it("标量与新增字段:原样给出前后值", () => {
    const after = structuredClone(base);
    after.config.model = "opus";
    after.description = "新说明";
    expect(diffSnapshots(base, after)).toEqual([
      { path: "config.model", kind: "changed", before: "sonnet", after: "opus" },
      { path: "description", kind: "added", after: "新说明" },
    ]);
  });
});

describe("lineDiff", () => {
  it("超过规模上限:不给行级差异(调用方只给前后值)", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
    expect(lineDiff(a, b)).toBeUndefined();
  });

  it("只改中间:首尾相同的部分先剥掉,长文本也算得动", () => {
    const head = Array.from({ length: 50_000 }, (_, i) => `l${i}`);
    const a = [...head, "旧", ...head];
    const b = [...head, "新", ...head];
    const d = lineDiff(a, b);
    expect(d?.filter((x) => x.op !== "same")).toEqual([
      { op: "del", text: "旧" },
      { op: "add", text: "新" },
    ]);
  });
});
