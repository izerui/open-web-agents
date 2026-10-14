import { escapeHatchChangeDenied } from "@/app/api/agents/_lib/escape-hatch-guard";
import { describe, expect, it } from "vitest";

const user = { userId: "u1", groupIds: [] };
const admin = { userId: "a1", role: "admin" as const, groupIds: [] };

describe("escapeHatchChangeDenied(回滚 / 载入草稿时的逃生舱守卫)", () => {
  it("普通作者:切到逃生舱不同的版本被拒(403)", async () => {
    const res = escapeHatchChangeDenied(user, undefined, { sandbox: { enabled: false } });
    expect(res?.status).toBe(403);
    expect(((await res?.json()) as { code?: string }).code).toBe("forbidden");
    // 管理员撤掉的逃生舱,也不能被普通作者借回滚恢复
    expect(escapeHatchChangeDenied(user, { a: 1 }, { a: 2 })?.status).toBe(403);
  });

  it("内容相同(含键顺序不同、都为空)时放行", () => {
    expect(escapeHatchChangeDenied(user, { a: 1, b: 2 }, { b: 2, a: 1 })).toBeNull();
    expect(escapeHatchChangeDenied(user, undefined, undefined)).toBeNull();
    expect(escapeHatchChangeDenied(user, undefined, null)).toBeNull();
  });

  it("平台管理员可以切换", () => {
    expect(escapeHatchChangeDenied(admin, undefined, { x: 1 })).toBeNull();
  });
});
