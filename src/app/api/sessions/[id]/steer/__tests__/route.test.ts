// 追加消息接口:答复如实反映结局;越权与不接受追加的会话在入队之前就挡住。

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  source: "web" as string,
  runSession: "s1" as string | null,
  offer: async (): Promise<"accepted" | "closed"> => "accepted",
  outcome: async (): Promise<"delivered" | "dropped" | "pending"> => "delivered",
  offered: [] as unknown[],
};

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "u1" }),
      assertSessionAccess: async () => {},
      assertCanInvoke: async () => {},
    },
    sessions: { get: async () => ({ id: "s1", agentId: "a1", source: state.source }) },
    runs: {
      get: async (id: string) =>
        state.runSession ? { id, sessionId: state.runSession, status: "running" } : null,
    },
    steerChannel: {
      offer: async (...args: unknown[]) => {
        state.offered.push(args);
        return state.offer();
      },
      awaitOutcome: async () => state.outcome(),
    },
  }),
}));

async function post(body: unknown) {
  const { POST } = await import("../route");
  const res = await POST(
    new Request("http://x/api/sessions/s1/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "s1" }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/sessions/{id}/steer", () => {
  beforeEach(() => {
    state.source = "web";
    state.runSession = "s1";
    state.offer = async () => "accepted";
    state.outcome = async () => "delivered";
    state.offered = [];
  });

  it("已交给模型:200 delivered", async () => {
    const r = await post({ runId: "r1", text: "  补充一句  " });
    expect(r).toMatchObject({ status: 200, body: { outcome: "delivered" } });
    expect(state.offered).toEqual([["r1", { id: expect.any(String), text: "补充一句" }]]);
  });

  it("等待上限内没等到结局:202 pending —— 不说成功也不说失败", async () => {
    state.outcome = async () => "pending";
    expect(await post({ runId: "r1", text: "x" })).toMatchObject({
      status: 202,
      body: { outcome: "pending" },
    });
  });

  it("没有受理:409 not_accepting;受理了但没送达:409 dropped", async () => {
    state.offer = async () => "closed";
    expect(await post({ runId: "r1", text: "x" })).toMatchObject({
      status: 409,
      body: { code: "not_accepting" },
    });
    state.offer = async () => "accepted";
    state.outcome = async () => "dropped";
    expect(await post({ runId: "r1", text: "x" })).toMatchObject({
      status: 409,
      body: { code: "dropped" },
    });
  });

  it("通道不可用:503", async () => {
    state.offer = async () => {
      throw new Error("redis down");
    };
    expect((await post({ runId: "r1", text: "x" })).status).toBe(503);
  });

  it("别的会话的运行:404,且根本不入队", async () => {
    state.runSession = "other";
    expect((await post({ runId: "r1", text: "x" })).status).toBe(404);
    state.runSession = null;
    expect((await post({ runId: "r1", text: "x" })).status).toBe(404);
    expect(state.offered).toEqual([]);
  });

  it("接口调用 / 嵌入组件的会话:409,且不入队", async () => {
    for (const source of ["invoke", "embed"]) {
      state.source = source;
      expect((await post({ runId: "r1", text: "x" })).status).toBe(409);
    }
    expect(state.offered).toEqual([]);
  });

  it("缺 runId 或空文本:400", async () => {
    expect((await post({ text: "x" })).status).toBe(400);
    expect((await post({ runId: "r1", text: "   " })).status).toBe(400);
    expect(state.offered).toEqual([]);
  });
});
