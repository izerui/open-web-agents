// 手动重发的来源限制:网页对话的运行被拒,拒绝原因确实是来源限制,且根本不会碰发件箱。
// (e2e 里网页运行的发件箱可能还处于待投,同样返回 409,只看状态码分不清是哪条规则拦的。)

import { describe, expect, it, vi } from "vitest";

const redeliver = vi.fn(async () => true);
let source = "web";

vi.mock("@/app/api/agents/_lib/webhook-access", () => ({
  openWebhookOwner: async () => ({
    ok: true,
    agent: { id: "a1", ownerId: "u1" },
    principal: { type: "web", userId: "u1" },
  }),
}));
vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: { resolveWeb: async () => ({ type: "web", userId: "u1" }) },
    runQuery: { detail: async () => ({ id: "r1", agentId: "a1", source, status: "success" }) },
    webhookConsole: { redeliver },
    audit: { record: async () => {} },
  }),
}));

async function post() {
  const { POST } = await import("../route");
  const res = await POST(
    new Request("http://x/api/runs/r1/webhook/redeliver", { method: "POST" }),
    {
      params: Promise.resolve({ id: "r1" }),
    },
  );
  return { status: res.status, body: (await res.json()) as { error?: string; code?: string } };
}

describe("手动重发:来源限制", () => {
  it("网页对话的运行:409,原因是来源限制,发件箱一次都没碰", async () => {
    source = "web";
    redeliver.mockClear();
    const r = await post();
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/只有接口调用与 API 会话/);
    expect(redeliver).not.toHaveBeenCalled();
  });

  it("接口调用的运行:放回发件箱,202", async () => {
    source = "invoke";
    redeliver.mockClear();
    expect((await post()).status).toBe(202);
    expect(redeliver).toHaveBeenCalledWith("r1");
  });
});
