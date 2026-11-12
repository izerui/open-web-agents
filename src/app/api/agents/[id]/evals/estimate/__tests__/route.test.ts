// GET /api/agents/[id]/evals/estimate:按草稿主模型的近期实扣预估一轮评测的花费。
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  samples: [] as string[],
  sampleCalls: [] as [string, string][],
  writer: true,
  cases: 3,
}));

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "me", role: "user" }),
      assertCanManageAgents: () => {},
      subjectOf: async () => ({ userId: "me", role: "user" }),
    },
    agents: {
      get: async (id: string) =>
        id === "a1"
          ? {
              id: "a1",
              ownerId: state.writer ? "me" : "other",
              name: "A1",
              visibility: "public",
              config: { systemPrompt: "p", model: "sonnet" },
            }
          : null,
    },
    grants: {
      listForResource: async () =>
        state.writer
          ? []
          : [
              {
                id: "g",
                resourceType: "agent",
                resourceId: "a1",
                principalType: "user",
                principalId: "me",
                permission: "read",
              },
            ],
    },
    evals: {
      listCases: async () => Array.from({ length: state.cases }, (_, i) => ({ id: `c${i}` })),
    },
    evalCostSamples: {
      recentChargedMicro: async (agentId: string, model: string) => {
        state.sampleCalls.push([agentId, model]);
        return state.samples;
      },
    },
  }),
}));

beforeEach(() => {
  state.samples = [];
  state.sampleCalls = [];
  state.writer = true;
  state.cases = 3;
});

async function get(id = "a1") {
  const { GET } = await import("../route");
  return GET(new Request(`http://x/api/agents/${id}/evals/estimate`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /api/agents/[id]/evals/estimate", () => {
  it("按草稿模型取样本,平均实扣 × 用例数", async () => {
    state.samples = ["1000", "2000"];
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cases: 3,
      model: "sonnet",
      samples: 2,
      avgMicroCredits: "1500",
      totalMicroCredits: "4500",
    });
    expect(state.sampleCalls).toEqual([["a1", "sonnet"]]);
  });

  it("没有样本:avg/total 为 null", async () => {
    const body = (await (await get()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      cases: 3,
      samples: 0,
      avgMicroCredits: null,
      totalMicroCredits: null,
    });
  });

  it("只有读权限:403;智能体不存在:404", async () => {
    state.writer = false;
    expect((await get()).status).toBe(403);
    expect((await get("missing")).status).toBe(404);
    expect(state.sampleCalls).toHaveLength(0);
  });
});
