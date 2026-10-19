// 追加消息接口:答复如实反映结局;越权与不接受追加的会话在入队之前就挡住。

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  source: "web" as string,
  runSession: "s1" as string | null,
  offer: async (): Promise<"accepted" | "rejected" | "delivered" | "dropped"> => "accepted",
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

  it("已交给模型:200 delivered;用的是调用方给的 id", async () => {
    const r = await post({ runId: "r1", id: "client-id-0001", text: "  补充一句  " });
    expect(r).toMatchObject({ status: 200, body: { id: "client-id-0001", outcome: "delivered" } });
    expect(state.offered).toEqual([["r1", { id: "client-id-0001", text: "补充一句" }]]);
  });

  it("id 格式不对:400,不入队", async () => {
    expect((await post({ runId: "r1", id: "短", text: "x" })).status).toBe(400);
    expect((await post({ runId: "r1", id: "a/b/c/d/e/f", text: "x" })).status).toBe(400);
    expect(state.offered).toEqual([]);
  });

  it("同一 id 早先已有结局:直接答那个结局,不再等", async () => {
    state.offer = async () => "delivered";
    expect(await post({ runId: "r1", id: "client-id-0001", text: "x" })).toMatchObject({
      status: 200,
      body: { outcome: "delivered" },
    });
    state.offer = async () => "dropped";
    expect(await post({ runId: "r1", id: "client-id-0001", text: "x" })).toMatchObject({
      status: 409,
      body: { code: "dropped" },
    });
  });

  it("等待上限内没等到结局:202 pending —— 不说成功也不说失败", async () => {
    state.outcome = async () => "pending";
    expect(await post({ runId: "r1", text: "x" })).toMatchObject({
      status: 202,
      body: { outcome: "pending" },
    });
  });

  it("没有受理:409 not_accepting;受理了但没送达:409 dropped", async () => {
    state.offer = async () => "rejected";
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

  it("受理请求没得到答复(可能已入队):202 unknown —— 不是 503,也不让调用方改作新消息", async () => {
    state.offer = async () => {
      throw new Error("Redis offer 超过 2000ms 未返回");
    };
    expect(await post({ runId: "r1", id: "client-id-0001", text: "x" })).toMatchObject({
      status: 202,
      body: { id: "client-id-0001", outcome: "unknown" },
    });
  });

  it("别的会话的运行:404,且根本不入队", async () => {
    state.runSession = "other";
    expect((await post({ runId: "r1", text: "x" })).status).toBe(404);
    state.runSession = null;
    expect((await post({ runId: "r1", text: "x" })).status).toBe(404);
    expect(state.offered).toEqual([]);
  });

  it("接口调用的会话:409,且不入队", async () => {
    state.source = "invoke";
    expect((await post({ runId: "r1", text: "x" })).status).toBe(409);
    expect(state.offered).toEqual([]);
  });

  it("缺 runId 或空文本:400", async () => {
    expect((await post({ text: "x" })).status).toBe(400);
    expect((await post({ runId: "r1", text: "   " })).status).toBe(400);
    expect(state.offered).toEqual([]);
  });
});
