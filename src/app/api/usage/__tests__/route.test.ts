// GET /api/usage 的 agentId 过滤:透传到用量查询(list 与 isTruncated 同一口径),权限口径不变。
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listCalls: [] as Record<string, unknown>[],
  truncCalls: [] as Record<string, unknown>[],
  role: "user" as "user" | "admin",
}));

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "me", role: state.role }),
      assertCanManageAgents: () => {},
    },
    usage: {
      list: async (q: Record<string, unknown>) => {
        state.listCalls.push(q);
        return [];
      },
      isTruncated: async (q: Record<string, unknown>) => {
        state.truncCalls.push(q);
        return false;
      },
      queueDepth: async () => ({ pending: 0, running: 0 }),
    },
    capabilities: { list: async () => [] },
    pricedModels: { forRun: async () => undefined },
  }),
}));

beforeEach(() => {
  state.listCalls = [];
  state.truncCalls = [];
  state.role = "user";
});

async function get(query = "") {
  const { GET } = await import("../route");
  return GET(new Request(`http://x/api/usage${query}`));
}

describe("GET /api/usage?agentId=", () => {
  it("带 agentId:透传到 list 与 isTruncated,仍只统计本人计费的", async () => {
    const res = await get("?agentId=a1&days=30");
    expect(res.status).toBe(200);
    expect(state.listCalls[0]).toMatchObject({ ownerId: "me", agentId: "a1" });
    expect(state.truncCalls[0]).toMatchObject({ ownerId: "me", agentId: "a1" });
  });

  it("不带 agentId:查询里没有 agentId", async () => {
    await get();
    expect(state.listCalls[0]).not.toHaveProperty("agentId");
    expect(state.truncCalls[0]).not.toHaveProperty("agentId");
    expect(state.listCalls[0]).toMatchObject({ ownerId: "me" });
  });

  it("管理员 scope=all 时同样可按智能体过滤", async () => {
    state.role = "admin";
    await get("?scope=all&agentId=a2");
    expect(state.listCalls[0]?.ownerId).toBeUndefined();
    expect(state.listCalls[0]).toMatchObject({ agentId: "a2" });
  });
});
