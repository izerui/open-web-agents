import {
  type RunAnchor,
  anchorForBranch,
  hasBranches,
  lineageOf,
} from "@/lib/modules/run/domain/branching";
import { describe, expect, it } from "vitest";

const r = (over: Partial<RunAnchor> & { id: string }): RunAnchor => ({ ...over });

describe("anchorForBranch / fresh", () => {
  it("锚点恒为空 —— 从零重开,上下文干净", () => {
    const target = r({ id: "r2", resumeAnchor: "sdk-1", sdkSessionId: "sdk-2" });
    expect(anchorForBranch(target, "fresh")).toEqual({
      ok: true,
      resumeAnchor: undefined,
      parentRunId: "r2",
    });
  });

  it("【SDK 边界】不拿目标轮的 resumeAnchor 去假装回溯 —— session id 不是时间点快照,\n     拿它 resume 得到的是最新状态,会变成看似分支实则继续主线的假功能", () => {
    const target = r({ id: "r2", resumeAnchor: "shared-session", sdkSessionId: "shared-session" });
    expect(anchorForBranch(target, "fresh").ok && anchorForBranch(target, "fresh")).toMatchObject({
      resumeAnchor: undefined,
    });
  });

  it("失败的轮次也能重跑 —— 正是最需要重跑的场景", () => {
    const target = r({ id: "r2", resumeAnchor: "sdk-1" });
    expect(anchorForBranch(target, "fresh").ok).toBe(true);
  });
});

describe("anchorForBranch / continue", () => {
  it("resume 目标轮产生的会话", () => {
    const target = r({ id: "r2", resumeAnchor: "sdk-1", sdkSessionId: "sdk-2" });
    expect(anchorForBranch(target, "continue")).toEqual({
      ok: true,
      resumeAnchor: "sdk-2",
      parentRunId: "r2",
    });
  });

  it("该轮没跑出会话状态时明确报错,不静默从零开始", () => {
    const target = r({ id: "r2", resumeAnchor: "sdk-1" });
    const a = anchorForBranch(target, "continue");
    expect(a.ok).toBe(false);
    expect(a.ok === false && a.reason).toMatch(/无法从它之后继续/);
  });
});

describe("lineageOf", () => {
  const runs = [
    r({ id: "r1", sdkSessionId: "s1" }),
    r({ id: "r2", parentRunId: "r1", resumeAnchor: "s1", sdkSessionId: "s2" }),
    r({ id: "r3", parentRunId: "r2", resumeAnchor: "s2", sdkSessionId: "s3" }),
    // 从 r2 分出的另一支
    r({ id: "r2b", parentRunId: "r1", resumeAnchor: "s1", sdkSessionId: "s2b" }),
  ];

  it("回溯出完整链路,根在最前", () => {
    expect(lineageOf("r3", runs).map((x) => x.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("另一支有自己的链路,不串到主线", () => {
    expect(lineageOf("r2b", runs).map((x) => x.id)).toEqual(["r1", "r2b"]);
  });

  it("根节点链路只有自己", () => {
    expect(lineageOf("r1", runs).map((x) => x.id)).toEqual(["r1"]);
  });

  it("不存在的 id 返回空", () => {
    expect(lineageOf("nope", runs)).toEqual([]);
  });

  it("父指向缺失时在断点处停住,不抛错", () => {
    const orphan = [r({ id: "x", parentRunId: "gone" })];
    expect(lineageOf("x", orphan).map((n) => n.id)).toEqual(["x"]);
  });

  it("数据异常形成环时不死循环", () => {
    const cyclic = [r({ id: "a", parentRunId: "b" }), r({ id: "b", parentRunId: "a" })];
    expect(lineageOf("a", cyclic).length).toBeLessThanOrEqual(2);
  });
});

describe("hasBranches", () => {
  const runs = [
    r({ id: "r1" }),
    r({ id: "r2", parentRunId: "r1" }),
    r({ id: "r2b", parentRunId: "r1" }),
  ];

  it("被别的运行当作父即有分支", () => {
    expect(hasBranches("r1", runs)).toBe(true);
  });
  it("叶子没有分支", () => {
    expect(hasBranches("r2", runs)).toBe(false);
  });
});

describe("anchorForBranch(rewind:从某一轮重来)", () => {
  // 主线三轮:同一个 SDK 会话 S,依次写进同一份 transcript
  const r1 = {
    id: "r1",
    sdkSessionId: "S",
    transcriptRange: { first: "a1", last: "z1" },
    createdAt: 1,
  };
  const r2 = {
    id: "r2",
    resumeAnchor: "S",
    sdkSessionId: "S",
    transcriptRange: { first: "a2", last: "z2" },
    createdAt: 2,
  };
  const r3 = {
    id: "r3",
    resumeAnchor: "S",
    sdkSessionId: "S",
    transcriptRange: { first: "a3", last: "z3" },
    createdAt: 3,
  };
  const all = [r1, r2, r3];

  it("重来第 3 轮:回到第 2 轮的最后一条消息之后", () => {
    expect(anchorForBranch(r3, "rewind", all)).toEqual({
      ok: true,
      parentRunId: "r3",
      resumeAnchor: "S",
      resumeAt: "z2",
    });
  });

  it("重来第 2 轮:回到第 1 轮之后 —— 不是「最近一轮」,而是目标之前的那一轮", () => {
    expect(anchorForBranch(r2, "rewind", all)).toMatchObject({ resumeAnchor: "S", resumeAt: "z1" });
  });

  it("重来首轮:之前没有对话,等同从零重开", () => {
    expect(anchorForBranch(r1, "rewind", all)).toEqual({
      ok: true,
      parentRunId: "r1",
      resumeAnchor: undefined,
    });
  });

  it("目标本身是「从某一轮重来」的分支:它之前的状态就是它自己的起点", () => {
    const b = { id: "b", resumeAnchor: "S", resumeAt: "z1", sdkSessionId: "F", createdAt: 9 };
    expect(anchorForBranch(b, "rewind", [...all, b])).toMatchObject({
      resumeAnchor: "S",
      resumeAt: "z1",
    });
  });

  it("只在同一份会话里找前一轮:别的会话(fork 出去的分支)不算", () => {
    const other = {
      id: "o",
      sdkSessionId: "F",
      transcriptRange: { first: "x", last: "zz" },
      createdAt: 2.5,
    };
    expect(anchorForBranch(r3, "rewind", [...all, other])).toMatchObject({ resumeAt: "z2" });
  });

  it("前一轮没有记录范围(旧数据):如实拒绝并给出代码,不猜", () => {
    const legacy = { ...r2, transcriptRange: undefined };
    const r = anchorForBranch(r3, "rewind", [r1, legacy, r3]);
    expect(r).toMatchObject({ ok: false, code: "rewind_unavailable" });
  });
});
