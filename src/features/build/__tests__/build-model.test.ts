import { describe, expect, it } from "vitest";
import {
  type EvalSummary,
  type LaunchInput,
  assertionText,
  canCloneAgent,
  draftEvalText,
  launchChecklist,
  ownerLabel,
  railStatus,
  readonlyHeaderText,
  runStats,
  shareModeText,
  stageBadges,
  stageFromParam,
  stageParam,
  versionEvalText,
} from "../build-model";

describe("阶段与地址", () => {
  it.each([
    [null, "orch"],
    ["", "orch"],
    ["eval", "eval"],
    ["publish", "publish"],
    ["access", "access"],
    ["runs", "runs"],
    ["bogus", "orch"],
  ])("stageFromParam(%s) = %s", (p, s) => {
    expect(stageFromParam(p)).toBe(s);
  });
  it("编排不写进地址", () => {
    expect(stageParam("orch")).toBeUndefined();
    expect(stageParam("eval")).toBe("eval");
  });
});

const passed: EvalSummary = {
  state: "passed",
  run: { id: "r", passed: 6, total: 6, createdAt: 1 },
};

describe("stageBadges:页头五个阶段的状态徽标", () => {
  const base = {
    readOnly: false,
    ready: true,
    filled: 9,
    caseCount: 6,
    draftEval: passed,
    publishedVersion: 3,
    hasUnpublishedChanges: true,
    changeCount: 4,
    keyCount: 0,
    runs7d: 214,
  };
  it("常规", () => {
    expect(stageBadges(base)).toEqual({
      orch: { text: "完整", tone: "ok" },
      eval: { text: "6/6 通过", tone: "ok" },
      publish: { text: "v3，4 处修改", tone: "warn" },
      access: { text: "未签 Key", tone: "" },
      runs: { text: "214 次", tone: "" },
    });
  });
  it("编排九节没填满时显示已填节数(名称和提示词齐了也不算完整);只读", () => {
    expect(stageBadges({ ...base, filled: 2 }).orch).toEqual({
      text: "2/9 节",
      tone: "",
    });
    expect(stageBadges({ ...base, filled: 4 }).orch).toEqual({ text: "4/9 节", tone: "" });
    expect(stageBadges({ ...base, readOnly: true }).orch).toEqual({ text: "只读", tone: "" });
  });
  it.each([
    [
      { caseCount: 0, draftEval: { state: "no_cases" } },
      { text: "无用例", tone: "" },
    ],
    [{ draftEval: { state: "none" } }, { text: "6 个未运行", tone: "" }],
    [
      { draftEval: { state: "none", previous: { id: "p", passed: 5, total: 5, createdAt: 1 } } },
      { text: "需重跑", tone: "warn" },
    ],
    [{ draftEval: { state: "running" } }, { text: "运行中", tone: "warn" }],
    [{ draftEval: { state: "cases_changed" } }, { text: "用例已改动", tone: "warn" }],
    [
      { draftEval: { state: "failed", run: { id: "r", passed: 4, total: 6, createdAt: 1 } } },
      { text: "4/6 通过", tone: "bad" },
    ],
    [{ draftEval: null }, { text: "6 个用例", tone: "" }],
  ])("评测 %j", (patch, badge) => {
    expect(stageBadges({ ...base, ...(patch as object) }).eval).toEqual(badge);
  });
  it("发布与接入", () => {
    expect(stageBadges({ ...base, publishedVersion: null }).publish).toEqual({
      text: "未发布",
      tone: "",
    });
    expect(stageBadges({ ...base, hasUnpublishedChanges: false }).publish).toEqual({
      text: "v3 已发布",
      tone: "ok",
    });
    expect(stageBadges({ ...base, changeCount: null }).publish.text).toBe("v3，有修改");
    expect(stageBadges({ ...base, keyCount: 2 }).access).toEqual({
      text: "Key 已签发",
      tone: "ok",
    });
  });
});

describe("launchChecklist:上线清单(A8)", () => {
  const base: LaunchInput = {
    ready: true,
    filled: 9,
    caseCount: 6,
    draftEval: passed,
    publishedVersion: 3,
    nextVersion: 4,
    hasUnpublishedChanges: true,
    changeCount: 4,
    justPublished: null,
    keyCount: 0,
    saving: false,
  };
  it("全部就绪时可以发布", () => {
    const c = launchChecklist(base);
    expect(c.items.map((i) => [i.key, i.ok])).toEqual([
      ["orch", true],
      ["eval", true],
      ["changes", true],
      ["publish", false],
      ["access", false],
    ]);
    expect(c.items[1]?.title).toBe("评测 6/6 通过");
    expect(c.items[2]?.detail).toBe("草稿与 v3 有 4 处差异");
    expect(c.items[3]?.title).toBe("发布 v4");
    expect(c.canPublish).toBe(true);
    expect(c.publishHint).toBe("");
    expect(c.readyCount).toBe(3);
  });
  it("编排不完整、评测失败时不能发布,并给出去处理的去向", () => {
    const c = launchChecklist({
      ...base,
      ready: false,
      draftEval: { state: "failed", run: { id: "r", passed: 4, total: 6, createdAt: 1 } },
    });
    expect(c.items[0]).toMatchObject({
      ok: false,
      detail: "名称和提示词是必填项",
      action: { label: "去处理", to: "orch" },
    });
    expect(c.items[1]).toMatchObject({
      ok: false,
      title: "评测全部通过",
      action: { label: "去修复", to: "fix" },
    });
    expect(c.canPublish).toBe(false);
    expect(c.publishHint).toBe("前三项都就绪后才能发布；回滚和设为发布版不受这个限制");
  });
  it("没有修改可发布", () => {
    const c = launchChecklist({ ...base, hasUnpublishedChanges: false, changeCount: 0 });
    expect(c.items[2]).toMatchObject({
      ok: false,
      title: "没有可发布的修改",
      detail: "草稿和当前发布版相同",
    });
    expect(c.canPublish).toBe(false);
    expect(c.publishHint).toBe("没有可发布的修改");
  });
  it("首次发布;草稿保存中暂不能发布", () => {
    const c = launchChecklist({
      ...base,
      publishedVersion: null,
      nextVersion: 1,
      hasUnpublishedChanges: false,
    });
    expect(c.items[2]).toMatchObject({ ok: true, title: "有修改可发布", detail: "首次发布" });
    expect(c.items[3]?.detail).toBe("未发布时，接口调用和其他人使用都直接跑草稿");
    const s = launchChecklist({ ...base, saving: true });
    expect(s.canPublish).toBe(false);
    expect(s.publishHint).toBe("草稿正在保存，稍后再发布");
  });
  it("刚发布成功:发布项打勾,引导去接入", () => {
    const c = launchChecklist({
      ...base,
      justPublished: 4,
      publishedVersion: 4,
      hasUnpublishedChanges: false,
      changeCount: 0,
    });
    expect(c.items[2]).toMatchObject({ ok: true, title: "草稿与发布版一致" });
    expect(c.items[3]).toMatchObject({ ok: true, title: "已发布 v4" });
    expect(c.items[4]).toMatchObject({ ok: false, action: { label: "去接入", to: "access" } });
  });
  it("已签 Key 后接入打勾", () => {
    expect(launchChecklist({ ...base, keyCount: 1 }).items[4]?.ok).toBe(true);
  });
});

describe("评测结论文案", () => {
  it("草稿", () => {
    expect(draftEvalText(passed, 6)).toBe("针对当前草稿，之后没改过配置或用例");
    expect(draftEvalText({ state: "no_cases" }, 0)).toBe("还没有用例，至少需要 1 个");
    expect(draftEvalText({ state: "none" }, 3)).toBe("3 个用例还没对当前草稿运行");
    expect(
      draftEvalText({ state: "none", previous: { id: "p", passed: 1, total: 2, createdAt: 1 } }, 3),
    ).toBe("配置变了，上次评测（1/2）不代表当前草稿，需要重跑");
  });
  it("版本列表", () => {
    expect(versionEvalText(passed)).toBe("评测 6/6 通过");
    expect(versionEvalText(undefined)).toBe("未评测");
    expect(versionEvalText({ state: "no_cases" })).toBe("无用例");
  });
});

describe("stageBadges:评测运行进度与运行次数口径", () => {
  const base = {
    readOnly: false,
    filled: 9,
    caseCount: 6,
    draftEval: { state: "running" } as EvalSummary,
    publishedVersion: null,
    hasUnpublishedChanges: false,
    changeCount: null,
    keyCount: 0,
    runs7d: null,
  };
  it("评测运行中带进度", () => {
    expect(stageBadges({ ...base, evalProgress: { done: 2, total: 6 } }).eval).toEqual({
      text: "运行中 2/6",
      tone: "warn",
    });
  });
  it("运行次数还没读到", () => {
    expect(stageBadges(base).runs).toEqual({ text: "…", tone: "" });
  });
});

describe("canCloneAgent:克隆入口统一(取舍 3)", () => {
  it("已上架且已发布才能克隆", () => {
    expect(canCloneAgent({ marketListed: true, publishedVersion: 2 })).toEqual({ ok: true });
    expect(canCloneAgent({ marketListed: false, publishedVersion: 2 })).toEqual({
      ok: false,
      reason: "只有已上架市场的智能体可以克隆",
    });
    expect(canCloneAgent({ marketListed: true, publishedVersion: null }).ok).toBe(false);
  });
});

describe("railStatus:左栏每个智能体的状态", () => {
  it.each([
    [
      { id: "a", isOwner: true, publishedVersion: 3, hasUnpublishedChanges: true },
      "v3，草稿有修改",
      "warn",
    ],
    [{ id: "a", isOwner: true, publishedVersion: 3 }, "已发布 v3", "ok"],
    [{ id: "a", isOwner: true, publishedVersion: null }, "草稿，未发布", ""],
    [{ id: "a", isOwner: false, canWrite: false }, "分享给我，只读", ""],
    [{ id: "a", isOwner: false, canWrite: true }, "分享给我，可编辑", ""],
    [{ id: "default", isOwner: false, publishedVersion: 1, canWrite: false }, "内置，只读", ""],
    [{ id: "default", isOwner: false, publishedVersion: null, canWrite: false }, "内置，只读", ""],
    [{ id: "a", isOwner: false, canWrite: false, isPublic: true }, "公开，只读", ""],
    [{ id: "default", isOwner: true, publishedVersion: 1 }, "内置，已发布 v1", "ok"],
    [{ id: "a", isOwner: false, canWrite: false, ownerName: "luojing" }, "luojing 分享，只读", ""],
    [{ id: "a", isOwner: false, canWrite: true, ownerName: "luojing" }, "luojing 分享，可编辑", ""],
    [
      { id: "a", isOwner: false, canWrite: false, isPublic: true, ownerName: "luojing" },
      "公开，只读",
      "",
    ],
  ])("%j", (a, text, tone) => {
    expect(railStatus(a)).toEqual({ text, tone });
  });
});

describe("分享人:只读视图、页头用的文案", () => {
  it("shareModeText:有分享人时写明谁分享的", () => {
    expect(shareModeText({ id: "a", ownerName: "luojing" })).toBe("luojing 分享给你");
    expect(shareModeText({ id: "a" })).toBe("分享给你");
    expect(shareModeText({ id: "a", isPublic: true, ownerName: "luojing" })).toBe(
      "luojing 公开给所有账号",
    );
    expect(shareModeText({ id: "a", isPublic: true })).toBe("公开给所有账号");
    expect(shareModeText({ id: "default", ownerName: "x" })).toBe("平台内置");
  });
  it("ownerLabel:所有者一栏", () => {
    expect(ownerLabel({ id: "a", ownerName: "luojing" })).toBe("luojing");
    expect(ownerLabel({ id: "a", ownerName: null })).toBe("另一个账号");
    expect(ownerLabel({ id: "agent-architect" })).toBe("平台");
  });
  it("readonlyHeaderText:页头「只读，X 所有」", () => {
    expect(readonlyHeaderText({ id: "a", ownerName: "luojing" })).toBe("只读，luojing 所有");
    expect(readonlyHeaderText({ id: "a" })).toBe("只读，分享给你");
    expect(readonlyHeaderText({ id: "default" })).toBe("只读，平台内置");
    expect(readonlyHeaderText(null)).toBe("只读，所有者管理");
  });
});

describe("assertionText:用例断言摘要", () => {
  it("按原型用「；」分隔", () => {
    expect(
      assertionText({
        fieldEquals: [{ path: "verdict", value: "reject" }],
        contains: ["抬头"],
        notContains: ["通过"],
        maxCostUsd: 0.05,
        maxDurationMs: 60000,
      }),
    ).toBe('verdict = "reject"；须包含「抬头」；不得包含「通过」；≤ $0.05；≤ 60s');
    expect(assertionText({})).toBe("只要求运行成功");
    expect(assertionText({ expectSuccess: false })).toBe("期望运行失败");
  });
});

describe("runStats:运行阶段的 7 天小统计(A17)", () => {
  it("调用次数、失败率、消耗积分", () => {
    expect(
      runStats({
        totals: { runs: 8, failed: 1 },
        runs: [
          { estimatedCredits: { totalMicroCredits: "1500000" } },
          { estimatedCredits: { totalMicroCredits: "500000" } },
          { estimatedCredits: null },
        ],
      }),
    ).toEqual({ runs: 8, failRate: "12.5%", microCredits: "2000000" });
    expect(runStats({})).toEqual({ runs: 0, failRate: "—", microCredits: "0" });
  });
});
