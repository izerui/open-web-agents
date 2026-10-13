import {
  type WebhookSender,
  WebhookTargetRejected,
  deliverWebhook,
} from "@/lib/modules/integration/application/webhook";
import { signWebhook } from "@/lib/modules/integration/domain/webhook-policy";
import { describe, expect, it, vi } from "vitest";

const payload = { taskId: "t1", status: "success", structured: { a: 1 } };
const noSleep = async () => {};

function fetchReturning(...statuses: number[]) {
  let i = 0;
  return vi.fn(async () => {
    const s = statuses[Math.min(i++, statuses.length - 1)] ?? 200;
    return new Response(null, { status: s });
  }) as unknown as WebhookSender;
}

describe("deliverWebhook", () => {
  it("2xx 一次成功", async () => {
    const r = await deliverWebhook("https://x/hook", payload, {
      send: fetchReturning(200),
      sleep: noSleep,
    });
    expect(r).toMatchObject({ delivered: true, attempts: 1, lastStatus: 200 });
  });

  it("POST 出 JSON body 与正确头", async () => {
    const spy = vi.fn(async () => new Response(null, { status: 200 }));
    await deliverWebhook("https://x/hook", payload, {
      send: spy as unknown as WebhookSender,
      sleep: noSleep,
    });
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(payload);
  });

  it("5xx 重试到成功", async () => {
    const r = await deliverWebhook("https://x/hook", payload, {
      send: fetchReturning(500, 200),
      sleep: noSleep,
    });
    expect(r).toMatchObject({ delivered: true, attempts: 2 });
  });

  it("429 也重试", async () => {
    const r = await deliverWebhook("https://x/hook", payload, {
      send: fetchReturning(429, 200),
      sleep: noSleep,
    });
    expect(r.delivered).toBe(true);
  });

  it("4xx 是对方拒收,不重试", async () => {
    const impl = fetchReturning(400);
    const r = await deliverWebhook("https://x/hook", payload, { send: impl, sleep: noSleep });
    expect(r).toMatchObject({ delivered: false, attempts: 1, lastStatus: 400 });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("一直 5xx 则用尽次数后放弃(不无限重试拖住 worker)", async () => {
    const impl = fetchReturning(503);
    const r = await deliverWebhook("https://x/hook", payload, {
      send: impl,
      sleep: noSleep,
      maxAttempts: 3,
    });
    expect(r).toMatchObject({ delivered: false, attempts: 3, lastStatus: 503 });
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it("网络错误也重试,并记录原因", async () => {
    let n = 0;
    const impl = vi.fn(async () => {
      if (n++ === 0) throw new Error("ECONNREFUSED");
      return new Response(null, { status: 200 });
    }) as unknown as WebhookSender;
    const r = await deliverWebhook("https://x/hook", payload, { send: impl, sleep: noSleep });
    expect(r.delivered).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it("全程网络错误时返回失败与错误信息,不抛异常", async () => {
    const impl = vi.fn(async () => {
      throw new Error("DNS fail");
    }) as unknown as WebhookSender;
    const r = await deliverWebhook("https://x/hook", payload, {
      send: impl,
      sleep: noSleep,
      maxAttempts: 2,
    });
    expect(r.delivered).toBe(false);
    expect(r.error).toMatch(/DNS fail/);
  });

  it("重试间隔递增(指数退避)", async () => {
    const waits: number[] = [];
    await deliverWebhook("https://x/hook", payload, {
      send: fetchReturning(500, 500, 200),
      sleep: async (ms) => {
        waits.push(ms);
      },
      maxAttempts: 3,
    });
    expect(waits).toEqual([500, 1000]);
  });
});

describe("deliverWebhook 签名与目标检查", () => {
  it("配了密钥就带时间戳与签名头,签名覆盖原样发出的请求体", async () => {
    const spy = vi.fn(async () => new Response(null, { status: 200 }));
    await deliverWebhook(
      "https://x/hook",
      { ...payload, deliveryId: "t1" },
      { send: spy as unknown as WebhookSender, sleep: noSleep, secret: "k", now: () => 5_000 },
    );
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h["X-OWA-Timestamp"]).toBe("5");
    expect(h["X-OWA-Delivery"]).toBe("t1");
    expect(h["X-OWA-Signature"]).toBe(signWebhook("k", 5, String(init.body)));
  });

  it("没配密钥就不带签名头", async () => {
    const spy = vi.fn(async () => new Response(null, { status: 200 }));
    await deliverWebhook("https://x/hook", payload, {
      send: spy as unknown as WebhookSender,
      sleep: noSleep,
    });
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-OWA-Signature"]).toBeUndefined();
  });

  it("发送器报目标被拒:立刻抛出,不做即时重试", async () => {
    const send = vi.fn(async () => {
      throw new WebhookTargetRejected("解析到 127.0.0.1");
    });
    await expect(
      deliverWebhook("https://x/hook", payload, {
        send: send as unknown as WebhookSender,
        sleep: noSleep,
        maxAttempts: 3,
      }),
    ).rejects.toBeInstanceOf(WebhookTargetRejected);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
