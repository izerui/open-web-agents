// 删除智能体的路由规则:只有所有者 / 管理员能删;内置智能体谁都不能删。
// (e2e 里建不出管理员,"管理员删内置智能体被拒"在这里验证。)

import { describe, expect, it, vi } from "vitest";

const softDelete = vi.fn(async () => true);
let opened: unknown;

vi.mock("@/app/api/agents/_lib/agent-access", () => ({ openAgent: async () => opened }));
vi.mock("@/lib/container", () => ({
  getContainer: () => ({ agents: { softDelete }, audit: { record: async () => {} } }),
}));

const del = async (id: string) => {
  const { DELETE } = await import("../route");
  const res = await DELETE(new Request(`http://x/api/agents/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: (await res.json()) as { error?: string } };
};

const as = (userId: string, role?: "admin", ownerId = "u1", id = "a1") => ({
  ok: true,
  agent: { id, ownerId, name: "n" },
  subject: { userId, role },
  principal: { type: "web", userId, role },
});

describe("DELETE /api/agents/{id}", () => {
  it("所有者可以删", async () => {
    softDelete.mockClear();
    opened = as("u1");
    expect((await del("a1")).status).toBe(200);
    expect(softDelete).toHaveBeenCalledTimes(1);
  });

  it("有 write 权限的协作者不能删", async () => {
    softDelete.mockClear();
    opened = as("u2");
    expect((await del("a1")).status).toBe(403);
    expect(softDelete).not.toHaveBeenCalled();
  });

  it("管理员也不能删内置智能体", async () => {
    softDelete.mockClear();
    for (const id of ["default", "agent-architect"]) {
      opened = as("root", "admin", "system", id);
      const r = await del(id);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/内置/);
    }
    expect(softDelete).not.toHaveBeenCalled();
  });
});
