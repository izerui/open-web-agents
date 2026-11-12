import { Forbidden } from "@/lib/modules/access/application/authorize";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ admin: true }));
vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "root" }),
      assertCanAdministerPlatform: () => {
        if (!state.admin) throw new Forbidden("admin only");
      },
      subjectOf: async () => ({ userId: "root", role: "admin" }),
    },
    modelAdmin: {
      aliasUsage: async () => ({ fable: 0, opus: 1, sonnet: 5, haiku: 2 }),
    },
  }),
}));
import { GET } from "../route";

const get = () => GET(new Request("http://test/api/admin/model-aliases"));

describe("GET /api/admin/model-aliases:每个别名有几个智能体在用", () => {
  beforeEach(() => {
    state.admin = true;
  });

  it("只有管理员能看", async () => {
    state.admin = false;
    expect((await get()).status).toBe(403);
  });

  it("返回每个别名的智能体数", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ usage: { fable: 0, opus: 1, sonnet: 5, haiku: 2 } });
  });
});
