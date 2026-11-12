import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: "user" as "user" | "admin",
  filters: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "alice" }),
      assertCanManageAgents: () => {},
      subjectOf: async () => ({ userId: "alice", role: state.role }),
    },
    audit: {
      list: async (f: Record<string, unknown>) => {
        state.filters.push(f);
        return { items: [] };
      },
    },
  }),
}));

import { GET } from "../route";

const get = (qs: string) => GET(new Request(`http://test/api/audit?${qs}`));

describe("GET /api/audit:按操作者筛选", () => {
  beforeEach(() => {
    state.role = "user";
    state.filters = [];
  });

  it("管理员看全平台时可按操作者筛", async () => {
    state.role = "admin";
    expect((await get("scope=all&actorId=bob")).status).toBe(200);
    expect(state.filters[0]).toMatchObject({ visibleTo: undefined, actorId: "bob" });
  });

  it("普通用户按操作者筛也只在与自己相关的范围内", async () => {
    expect((await get("actorId=bob")).status).toBe(200);
    expect(state.filters[0]).toMatchObject({ visibleTo: "alice", actorId: "bob" });
  });
});
