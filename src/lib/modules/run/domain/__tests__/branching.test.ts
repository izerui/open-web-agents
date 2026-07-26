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
