import {
  type StudioAgent,
  blankCreateBody,
  deleteBlock,
  filterStudio,
  formatUpdated,
  sharedByText,
  studioAgents,
  studioBadges,
  studioCounts,
  studioKind,
  studioSource,
  validateNewAgentId,
} from "@/features/studio/studio-model";
import { describe, expect, it } from "vitest";

const a = (id: string, extra: Partial<StudioAgent> = {}): StudioAgent => ({
  id,
  name: id,
  config: {},
  isOwner: true,
  canWrite: true,
  canManageWebhook: true,
  ...extra,
});

describe("studioKind", () => {
  it("内置 / 我建的 / 分享给我的", () => {
    expect(studioKind(a("default"))).toBe("builtin");
    expect(studioKind(a("agent-architect", { isOwner: false }))).toBe("builtin");
    expect(studioKind(a("x"))).toBe("mine");
    expect(studioKind(a("y", { isOwner: false }))).toBe("shared");
  });
});

const labels = (x: StudioAgent) => studioBadges(x).map((b) => `${b.variant}:${b.label}`);

describe("studioBadges", () => {
  it("已发布且草稿有修改", () => {
    expect(labels(a("x", { publishedVersion: 3, hasUnpublishedChanges: true }))).toEqual([
      "success:已发布 v3",
      "warning:草稿有修改",
    ]);
  });
  it("未发布、已上架、接口", () => {
    expect(
      labels(a("x", { marketListed: true, config: { outputSchema: { type: "object" } } })),
    ).toEqual(["default:未发布", "outline:已上架", "outline:接口"]);
  });
  it("分享来的:只读 / 可编辑,不显示草稿状态", () => {
    expect(
      labels(
        a("y", {
          isOwner: false,
          canWrite: false,
          publishedVersion: 2,
          hasUnpublishedChanges: true,
        }),
      ),
    ).toEqual(["outline:只读"]);
    expect(labels(a("y", { isOwner: false, canWrite: true }))).toEqual(["outline:可编辑"]);
  });
  it("内置", () => {
    expect(labels(a("default", { publishedVersion: 1 }))).toEqual([
      "dark:内置",
      "success:已发布 v1",
    ]);
  });
});

describe("filterStudio / studioCounts", () => {
  const list = [
    a("expense", { name: "报销审核", description: "读发票" }),
    a("meeting", { name: "会议纪要" }),
    a("shared-1", { isOwner: false, name: "合同比对" }),
    a("default", { name: "通用助手" }),
  ];
  it("页签", () => {
    expect(filterStudio(list, "mine", "").map((x) => x.id)).toEqual(["expense", "meeting"]);
    expect(filterStudio(list, "shared", "").map((x) => x.id)).toEqual(["shared-1"]);
    expect(filterStudio(list, "all", "")).toHaveLength(4);
  });
  it("搜索名称、ID、描述,忽略大小写与首尾空格", () => {
    expect(filterStudio(list, "all", " 发票 ").map((x) => x.id)).toEqual(["expense"]);
    expect(filterStudio(list, "all", "MEET").map((x) => x.id)).toEqual(["meeting"]);
    expect(filterStudio(list, "mine", "合同")).toEqual([]);
  });
  it("计数", () => {
    expect(studioCounts(list)).toEqual({ mine: 2, shared: 1, all: 4 });
  });
});

describe("studioSource", () => {
  it("来源文案", () => {
    expect(studioSource(a("x"))).toBe("我建的");
    expect(studioSource(a("default", { isOwner: false }))).toBe("平台内置");
    expect(studioSource(a("y", { isOwner: false }))).toBe("分享给我的");
    expect(studioSource(a("z", { isOwner: false, isPublic: true }))).toBe("公开");
    expect(studioSource(a("y", { isOwner: false, ownerName: "luojing" }))).toBe("luojing 分享");
  });
  it("sharedByText:卡片 ID 后面的分享人(原型「id，X 分享」)", () => {
    expect(sharedByText(a("y", { isOwner: false, ownerName: "luojing" }))).toBe("luojing 分享");
    expect(sharedByText(a("y", { isOwner: false }))).toBeNull();
    expect(sharedByText(a("y", { isOwner: true, ownerName: "x" }))).toBeNull();
    expect(sharedByText(a("default", { isOwner: false, ownerName: "x" }))).toBeNull();
  });
});

describe("studioAgents", () => {
  it("去掉只有市场使用权的条目", () => {
    expect(studioAgents([a("x"), a("m", { canRead: false })]).map((x) => x.id)).toEqual(["x"]);
  });
});

describe("validateNewAgentId", () => {
  it("留空合法", () => expect(validateNewAgentId("  ", [])).toBeNull());
  it("格式", () => {
    expect(validateNewAgentId("ok-1", [])).toBeNull();
    for (const bad of ["A", "a", "-ab", "ab_c", "中文", "a".repeat(37)]) {
      expect(validateNewAgentId(bad, [])).toMatch(/小写字母/);
    }
    expect(validateNewAgentId("a".repeat(36), [])).toBeNull();
  });
  it("已被占用", () => {
    expect(validateNewAgentId(" taken ", ["taken"])).toBe("ID 已被占用");
  });
});

describe("deleteBlock", () => {
  it("所有者或管理员可删(与 Builder 同一判定:canManageWebhook)", () => {
    expect(deleteBlock(a("x"))).toBeNull();
    expect(deleteBlock(a("x", { isOwner: false, canManageWebhook: true }))).toBeNull();
  });
  it("内置不能删", () => {
    expect(deleteBlock(a("default"))).toBe("内置智能体不能删除");
    expect(deleteBlock(a("agent-architect"))).toBe("内置智能体不能删除");
  });
  it("协作者不能删", () => {
    expect(deleteBlock(a("y", { isOwner: false, canManageWebhook: false }))).toBe(
      "只有所有者或管理员可以删除",
    );
  });
});

describe("formatUpdated", () => {
  const now = new Date(2026, 10, 12, 18, 0).getTime();
  it("今天 / 昨天 / 本年 / 跨年 / 没有", () => {
    expect(formatUpdated(new Date(2026, 10, 12, 9, 5).getTime(), now)).toBe("今天 09:05");
    expect(formatUpdated(new Date(2026, 10, 11, 23, 59).getTime(), now)).toBe("昨天");
    expect(formatUpdated(new Date(2026, 0, 3).getTime(), now)).toBe("01-03");
    expect(formatUpdated(new Date(2025, 11, 31).getTime(), now)).toBe("2025-12-31");
    expect(formatUpdated(null, now)).toBe("—");
  });
});

describe("blankCreateBody", () => {
  it("名称去空格,ID 留空不传,给占位提示词,只新建", () => {
    const body = blankCreateBody({
      name: " 差旅报销 ",
      id: " ",
      description: "",
      icon: "avatar:#F2B49B:pill",
    });
    expect(body).toMatchObject({ name: "差旅报销", icon: "avatar:#F2B49B:pill", createOnly: true });
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("description");
    expect(body.config.systemPrompt).toContain("差旅报销");
  });
  it("带 ID 与描述", () => {
    const body = blankCreateBody({ name: "x", id: " my-x ", description: " 做事 ", icon: "" });
    expect(body).toMatchObject({ id: "my-x", description: "做事" });
    expect(body).not.toHaveProperty("icon");
    expect(body.config.systemPrompt).toContain("做事");
  });
});
