import { Unauthorized } from "@/lib/modules/access/application/authorize";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ loggedIn: true }));

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => {
        if (!state.loggedIn) throw new Unauthorized("login required");
        return { type: "web", userId: "me", role: "user" };
      },
    },
  }),
}));

beforeEach(() => {
  state.loggedIn = true;
});

describe("GET /api/agents/templates", () => {
  it("登录后返回 6 个模板,带新建弹层要展示的字段", async () => {
    const { GET } = await import("../route");
    const res = await GET(new Request("http://x/api/agents/templates"));
    expect(res.status).toBe(200);
    const { templates } = (await res.json()) as { templates: Record<string, unknown>[] };
    expect(templates).toHaveLength(6);
    for (const t of templates) {
      expect(Object.keys(t).sort()).toEqual(
        [
          "category",
          "description",
          "icon",
          "id",
          "model",
          "name",
          "starters",
          "systemPrompt",
        ].sort(),
      );
    }
  });

  it("未登录 401", async () => {
    state.loggedIn = false;
    const { GET } = await import("../route");
    const res = await GET(new Request("http://x/api/agents/templates"));
    expect(res.status).toBe(401);
  });
});
