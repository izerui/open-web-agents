// 设计器改动的处理记录:写进设计会话的服务端状态(替代原来的本机 localStorage)。

import { DesignError } from "@/lib/modules/agent/application/designer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as { subject: unknown; id: string; body: unknown }[],
  fail: null as Error | null,
  denied: false,
}));

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => {
        if (state.denied) {
          const { Unauthorized } = await import("@/lib/modules/access/application/authorize");
          throw new Unauthorized("请先登录");
        }
        return { type: "web", userId: "me", role: "user" };
      },
      assertCanManageAgents: () => {},
      subjectOf: async () => ({ userId: "me", role: "user" }),
    },
    designer: {
      recordOutcomes: async (subject: unknown, id: string, body: unknown) => {
        state.calls.push({ subject, id, body });
        if (state.fail) throw state.fail;
        return { "run-1": [{ section: "prompt", count: 1, applied: true }] };
      },
    },
  }),
}));

beforeEach(() => {
  state.calls = [];
  state.fail = null;
  state.denied = false;
});

async function post(body: unknown) {
  const { POST } = await import("../route");
  const res = await POST(
    new Request("http://x/api/agents/design/s1/outcomes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "s1" }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/agents/design/[id]/outcomes", () => {
  it("按当前账号写入,返回全部处理记录", async () => {
    const body = { turnKey: "run-1", outcomes: [{ section: "prompt", count: 1, applied: true }] };
    const r = await post(body);
    expect(r.status).toBe(200);
    expect(r.body.outcomes).toEqual({ "run-1": [{ section: "prompt", count: 1, applied: true }] });
    expect(state.calls).toEqual([{ subject: { userId: "me", role: "user" }, id: "s1", body }]);
  });

  it("请求体不是对象 400,不调用", async () => {
    expect((await post("[1]")).status).toBe(400);
    expect((await post("bad")).status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it("别人的设计会话按领域错误返回(404),校验失败 400", async () => {
    state.fail = new DesignError(404, "not_found", "设计会话不存在");
    expect((await post({ turnKey: "a", outcomes: [] })).status).toBe(404);
    state.fail = new DesignError(400, "invalid_request", "outcomes 须是 1~20 项");
    expect((await post({ turnKey: "a", outcomes: [] })).status).toBe(400);
  });

  it("未登录 401", async () => {
    state.denied = true;
    expect((await post({})).status).toBe(401);
  });
});
