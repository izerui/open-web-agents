// 测试投递已送达、投递记录写入却永不返回 / 失败:接口仍要在上限内返回真实的投递结果。
// 真实的路由处理函数 + 真实的 WebhookConsole,只换掉权限检查与依赖。

import { WebhookConsole } from "@/lib/modules/integration/application/webhook-console";
import type { WebhookDeliveryLog } from "@/lib/modules/integration/ports";
import { describe, expect, it, vi } from "vitest";

const state: { log?: WebhookDeliveryLog; errors: unknown[]; sent: number } = {
  errors: [],
  sent: 0,
};

vi.mock("@/app/api/agents/_lib/webhook-access", () => ({
  openWebhookOwner: async () => ({
    ok: true,
    agent: { id: "a1", ownerId: "u1" },
    principal: { type: "web", userId: "u1" },
  }),
}));
vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    webhookConsole: new WebhookConsole({
      targetOfAgent: async (agentId) => ({
        agentId,
        url: "https://hook.example.com/in",
        secret: "s",
      }),
      deliver: async () => {
        state.sent++;
        return { delivered: true, attempts: 1, lastStatus: 204 };
      },
      log: state.log as WebhookDeliveryLog,
      outbox: { requeueWebhook: async () => false },
      recordTimeoutMs: 200,
      onRecordError: (e) => state.errors.push(e),
    }),
    audit: { record: async () => {} },
  }),
}));

async function post() {
  const { POST } = await import("../route");
  const t0 = Date.now();
  const res = await POST(new Request("http://x/api/agents/a1/webhook/test", { method: "POST" }), {
    params: Promise.resolve({ id: "a1" }),
  });
  return {
    res,
    ms: Date.now() - t0,
    body: (await res.json()) as { delivery?: { ok: boolean; httpStatus?: number } },
  };
}

describe("测试投递:投递记录写入出问题不影响返回", () => {
  it("记录写入永不兑现:仍在上限内返回 200 与真实投递结果", async () => {
    state.errors = [];
    state.sent = 0;
    state.log = {
      record: () => new Promise<never>(() => {}),
      listByAgent: async () => ({ items: [] }),
    };
    const { res, ms, body } = await post();
    expect(res.status).toBe(200);
    expect(body.delivery).toMatchObject({ ok: true, httpStatus: 204 });
    expect(state.sent).toBe(1);
    expect(ms).toBeLessThan(1500);
    expect(String(state.errors[0])).toMatch(/底层写入未取消/);
  });

  it("记录写入失败(reject):不变成 500,仍返回真实投递结果", async () => {
    state.errors = [];
    state.log = {
      record: async () => {
        throw new Error("db down");
      },
      listByAgent: async () => ({ items: [] }),
    };
    const { res, body } = await post();
    expect(res.status).toBe(200);
    expect(body.delivery?.ok).toBe(true);
    expect(String(state.errors[0])).toMatch(/db down/);
  });
});
