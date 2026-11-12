import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ user: "alice", role: "user" as "admin" | "user" }));
const run = {
  id: "r1",
  sessionId: "s1",
  agentId: "a1",
  status: "success",
  prompt: "hi",
  ownership: { ownerId: "alice" },
  account: { id: "alice", email: "alice@example.test" },
};

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    runQuery: { detail: async (id: string) => (id === "r1" ? { ...run } : null) },
    auth: {
      resolveWeb: async () => ({ type: "web", userId: state.user, role: state.role }),
    },
  }),
}));

import { GET } from "../[id]/route";

const get = async (id = "r1") =>
  GET(new Request(`http://local/api/runs/${id}`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  state.user = "alice";
  state.role = "user";
});

describe("GET /api/runs/[id]:能否打开对应会话", () => {
  it("本人的运行:canOpenSession = true,不回归属信息", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run.canOpenSession).toBe(true);
    expect(body.run.ownership).toBeUndefined();
    expect(body.run.account).toBeUndefined();
  });

  it("管理员看别人的运行:能看运行详情,但会话是私有的,canOpenSession = false", async () => {
    state.user = "root";
    state.role = "admin";
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run.canOpenSession).toBe(false);
    // 平台运行要看得出是谁的运行
    expect(body.run.account).toEqual({ id: "alice", email: "alice@example.test" });
  });

  it("别人(非管理员)看不到:404", async () => {
    state.user = "mallory";
    expect((await get()).status).toBe(404);
  });
});
