// 分享设置:列表带上人能看懂的对象名(账号邮箱、组名),构建页的定向分享列表不再只显示内部 id。

import { describe, expect, it, vi } from "vitest";

const grants = [
  { id: "g1", principalType: "*", principalId: "*", permission: "read" },
  { id: "g2", principalType: "user", principalId: "u2", permission: "write" },
  { id: "g3", principalType: "group", principalId: "grp", permission: "read" },
  { id: "g4", principalType: "user", principalId: "gone", permission: "read" },
];

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "me", role: "user" }),
      subjectOf: async () => ({ userId: "me", role: "user", groupIds: [] }),
    },
    agents: { get: async (id: string) => ({ id, ownerId: "me", name: "A", config: {} }) },
    grants: { listForResource: async () => grants },
    users: {
      get: async (id: string) => (id === "u2" ? { id: "u2", email: "u2@example.test" } : null),
    },
    groups: { get: async (id: string) => (id === "grp" ? { id: "grp", name: "财务部" } : null) },
  }),
}));

describe("GET /api/agents/[id]/share", () => {
  it("每条授权带上 label:账号邮箱、组名;查不到时为空", async () => {
    const { GET } = await import("../route");
    const res = await GET(new Request("http://x/api/agents/a/share"), {
      params: Promise.resolve({ id: "a" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grants: { id: string; label?: string | null }[] };
    expect(body.grants.map((g) => [g.id, g.label ?? null])).toEqual([
      ["g1", null],
      ["g2", "u2@example.test"],
      ["g3", "财务部"],
      ["g4", null],
    ]);
  });
});
