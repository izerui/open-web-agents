import { avatarStyle, formatAvatarIcon } from "@/lib/agent-avatar";
import { AGENT_TEMPLATES, findTemplate, templateCreateBody } from "@/lib/modules/agent/templates";
import { MODEL_ALIASES } from "@/lib/shared";
import { describe, expect, it } from "vitest";

describe("AGENT_TEMPLATES", () => {
  it("恰好 6 个场景模板,id 唯一", () => {
    expect(AGENT_TEMPLATES.map((t) => t.name)).toEqual([
      "报销初审",
      "客服问答",
      "周报生成",
      "会议纪要",
      "合同比对",
      "SQL 助手",
    ]);
    expect(new Set(AGENT_TEMPLATES.map((t) => t.id)).size).toBe(6);
  });

  it.each(AGENT_TEMPLATES.map((t) => [t.id, t] as const))("%s 字段齐全", (_, t) => {
    expect(t.id).toMatch(/^[a-z0-9-]+$/);
    expect(t.category.trim()).not.toBe("");
    expect(t.description.trim()).not.toBe("");
    expect(t.systemPrompt.trim().length).toBeGreaterThan(40);
    expect(MODEL_ALIASES).toContain(t.model);
    expect(t.starters.length).toBeGreaterThanOrEqual(1);
    expect(t.starters.length).toBeLessThanOrEqual(4);
    // 头像必须是合法的 avatar:<色>:<眼睛>,否则会被当成没设置
    expect(formatAvatarIcon(avatarStyle("x", t.icon))).toBe(t.icon);
  });
});

describe("templateCreateBody", () => {
  it("按模板生成创建请求", () => {
    const sql = findTemplate("sql-helper");
    const body = templateCreateBody("sql-helper");
    expect(body).toEqual({
      name: "SQL 助手",
      description: sql?.description,
      icon: sql?.icon,
      createOnly: true,
      config: { systemPrompt: sql?.systemPrompt, model: sql?.model, starters: sql?.starters },
    });
  });

  it("自定义名称与 ID 覆盖模板默认值,空白名称回落到模板名", () => {
    expect(
      templateCreateBody("weekly-report", { name: "  我的周报 ", id: " my-weekly " }),
    ).toMatchObject({
      name: "我的周报",
      id: "my-weekly",
    });
    const body = templateCreateBody("weekly-report", { name: "  ", id: "" });
    expect(body?.name).toBe("周报生成");
    expect(body && "id" in body).toBe(false);
  });

  it("未知模板返回 null", () => {
    expect(templateCreateBody("nope")).toBeNull();
    expect(findTemplate("")).toBeUndefined();
  });

  it("返回的配置是副本,改它不影响目录", () => {
    const body = templateCreateBody("meeting-minutes");
    body?.config.starters.push("x");
    expect(findTemplate("meeting-minutes")?.starters).not.toContain("x");
  });
});
