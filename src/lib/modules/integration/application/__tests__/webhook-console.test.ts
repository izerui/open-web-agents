import { WebhookTargetRejected } from "@/lib/modules/integration/application/webhook";
import { WebhookConsole } from "@/lib/modules/integration/application/webhook-console";
import type { WebhookDelivery } from "@/lib/modules/integration/ports";
import { describe, expect, it } from "vitest";

function setup(over: Partial<ConstructorParameters<typeof WebhookConsole>[0]> = {}) {
  const records: WebhookDelivery[] = [];
  const sent: { url: string; event?: string; secret?: string }[] = [];
  const c = new WebhookConsole({
    targetOfAgent: async (agentId) => ({
      agentId,
      url: "https://hook.example.com/in?k=1",
      secret: "s",
    }),
    deliver: async (url, p, secret) => {
      sent.push({ url, event: p.event, secret });
      return { delivered: true, attempts: 1, lastStatus: 204 };
    },
    log: {
      record: async (d) => {
        records.push(d);
      },
      listByAgent: async () => ({ items: records }),
    },
    outbox: { requeueWebhook: async () => true },
    now: () => 5000,
    ...over,
  });
  return { c, records, sent };
}

describe("WebhookConsole", () => {
  it("测试投递:发 webhook.test、带签名,结果记入投递记录(地址脱敏)", async () => {
    const { c, records, sent } = setup();
    const r = await c.sendTest("a1");
    expect(sent).toEqual([
      { url: "https://hook.example.com/in?k=1", event: "webhook.test", secret: "s" },
    ]);
    expect(r).toMatchObject({
      configured: true,
      delivery: {
        trigger: "test",
        ok: true,
        httpStatus: 204,
        signed: true,
        url: "https://hook.example.com/in",
      },
    });
    expect(records).toHaveLength(1);
  });

  it("没配回调:不发、不记,返回未配置", async () => {
    const { c, records, sent } = setup({ targetOfAgent: async () => null });
    expect(await c.sendTest("a1")).toEqual({ configured: false });
    expect(sent).toEqual([]);
    expect(records).toEqual([]);
  });

  it("目标被拒 / 网络错误:如实记为失败,不抛给调用方", async () => {
    const { c } = setup({
      deliver: async () => {
        throw new WebhookTargetRejected("解析到内网地址");
      },
    });
    const r = await c.sendTest("a1");
    expect(r).toMatchObject({ configured: true, delivery: { ok: false } });
    if (r.configured) expect(r.delivery.error).toMatch(/目标被拒/);
  });
});
