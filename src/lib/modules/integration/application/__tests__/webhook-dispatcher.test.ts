import type { WebhookPayload, WebhookResult } from "@/lib/modules/integration/application/webhook";
import { WebhookTargetRejected } from "@/lib/modules/integration/application/webhook";
import {
  type DispatcherDeps,
  WebhookDispatcher,
} from "@/lib/modules/integration/application/webhook-dispatcher";
import type { WebhookOutbox } from "@/lib/modules/integration/ports";
import { describe, expect, it } from "vitest";

/** 一条待投递的内存发件箱。 */
class OneJobOutbox implements WebhookOutbox {
  marks: { state: string; nextAt?: number }[] = [];
  constructor(private job: { runId: string; sessionId: string; attempts: number } | null) {}
  async claimWebhook() {
    const j = this.job;
    this.job = null;
    return j;
  }
  async markWebhook(
    _runId: string,
    state: "delivered" | "failed" | "skipped" | "pending",
    nextAt?: number,
  ) {
    this.marks.push({ state, nextAt });
  }
}

const payload: WebhookPayload = { taskId: "r1", status: "success" };

function make(
  outbox: OneJobOutbox,
  over: Partial<DispatcherDeps> & { result?: WebhookResult } = {},
) {
  const sent: { url: string; secret?: string }[] = [];
  const d = new WebhookDispatcher({
    outbox,
    loadTarget: async () => ({ url: "https://x/hook", secret: "s" }),
    loadPayload: async () => payload,
    deliver: async (url, _p, secret) => {
      sent.push({ url, secret });
      return over.result ?? { delivered: true, attempts: 1, lastStatus: 200 };
    },
    now: () => 1000,
    ...over,
  });
  return { d, sent };
}

describe("WebhookDispatcher", () => {
  it("投递成功标 delivered,并带上所有者的签名密钥", async () => {
    const box = new OneJobOutbox({ runId: "r1", sessionId: "s1", attempts: 1 });
    const { d, sent } = make(box);
    expect(await d.runOnce()).toBe(1);
    expect(sent).toEqual([{ url: "https://x/hook", secret: "s" }]);
    expect(box.marks).toEqual([{ state: "delivered", nextAt: undefined }]);
  });

  it("没配回调标 skipped,不发请求", async () => {
    const box = new OneJobOutbox({ runId: "r1", sessionId: "s1", attempts: 1 });
    const { d, sent } = make(box, { loadTarget: async () => null });
    await d.runOnce();
    expect(sent).toEqual([]);
    expect(box.marks[0]?.state).toBe("skipped");
  });

  it("5xx 按退避表安排下一次", async () => {
    const box = new OneJobOutbox({ runId: "r1", sessionId: "s1", attempts: 1 });
    const { d } = make(box, { result: { delivered: false, attempts: 2, lastStatus: 503 } });
    await d.runOnce();
    expect(box.marks).toEqual([{ state: "pending", nextAt: 1000 + 30_000 }]);
  });

  it("重试次数用完标 failed", async () => {
    const box = new OneJobOutbox({ runId: "r1", sessionId: "s1", attempts: 6 });
    const { d } = make(box, { result: { delivered: false, attempts: 2, lastStatus: 500 } });
    await d.runOnce();
    expect(box.marks[0]?.state).toBe("failed");
  });

  it("4xx 是对方拒收,不重试", async () => {
    const box = new OneJobOutbox({ runId: "r1", sessionId: "s1", attempts: 1 });
    const { d } = make(box, { result: { delivered: false, attempts: 1, lastStatus: 401 } });
    await d.runOnce();
    expect(box.marks[0]?.state).toBe("failed");
  });

  it("目标地址被策略拒绝:直接 failed", async () => {
    const box = new OneJobOutbox({ runId: "r1", sessionId: "s1", attempts: 1 });
    const { d } = make(box, {
      deliver: async () => {
        throw new WebhookTargetRejected("解析到 127.0.0.1");
      },
    });
    await d.runOnce();
    expect(box.marks[0]?.state).toBe("failed");
  });

  it("签名密钥解不开:不发不签名的请求,直接 failed", async () => {
    const box = new OneJobOutbox({ runId: "r1", sessionId: "s1", attempts: 1 });
    const { d, sent } = make(box, {
      loadTarget: async () => {
        throw new Error("无法解密");
      },
    });
    await d.runOnce();
    expect(sent).toEqual([]);
    expect(box.marks[0]?.state).toBe("failed");
  });
});
