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
  /** 写回是否被接受(模拟令牌失效时为 false) */
  accept = true;
  private job: {
    runId: string;
    sessionId: string;
    attempts: number;
    lease: string;
    callback?: { source: "agent" | "caller"; url: string } | { source: "none" };
  } | null;
  constructor(
    job: {
      runId: string;
      sessionId: string;
      attempts: number;
      callback?: { source: "agent" | "caller"; url: string };
    } | null,
  ) {
    this.job = job ? { ...job, lease: "L1" } : null;
  }
  async claimWebhook() {
    const j = this.job;
    this.job = null;
    return j;
  }
  async markWebhook(
    _runId: string,
    lease: string,
    state: "delivered" | "failed" | "skipped" | "pending",
    nextAt?: number,
  ) {
    expect(lease).toBe("L1"); // 写回必须带上认领时拿到的令牌
    this.marks.push({ state, nextAt });
    return this.accept;
  }
  async requeueWebhook() {
    return false;
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
    loadTarget: async () => ({ agentId: "a1", url: "https://x/hook?token=t0p", secret: "s" }),
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
    expect(sent).toEqual([{ url: "https://x/hook?token=t0p", secret: "s" }]);
    expect(box.marks).toEqual([{ state: "delivered", nextAt: undefined }]);
  });

  it("认领到的回调快照原样交给目标解析,投到解析出的地址", async () => {
    const box = new OneJobOutbox({
      runId: "r1",
      sessionId: "s1",
      attempts: 1,
      callback: { source: "caller", url: "https://caller.example.com/cb" },
    });
    const seen: unknown[] = [];
    const { d, sent } = make(box, {
      loadTarget: async (job) => {
        seen.push({ sessionId: job.sessionId, callback: job.callback });
        return {
          agentId: "a1",
          url: job.callback?.source === "caller" ? job.callback.url : "https://owner/hook",
        };
      },
    });
    await d.runOnce();
    expect(seen).toEqual([
      { sessionId: "s1", callback: { source: "caller", url: "https://caller.example.com/cb" } },
    ]);
    expect(sent).toEqual([{ url: "https://caller.example.com/cb", secret: undefined }]);
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

describe("WebhookDispatcher:投递记录", () => {
  it("每次投递记一行:归属智能体、第几次、状态码、是否签名;地址去掉查询串", async () => {
    const box = new OneJobOutbox({ runId: "r1", sessionId: "s1", attempts: 3 });
    const recs: unknown[] = [];
    const { d } = make(box, {
      result: { delivered: false, attempts: 2, lastStatus: 503, error: "upstream" },
      recordDelivery: async (rec) => {
        recs.push(rec);
      },
    });
    await d.runOnce();
    expect(recs).toEqual([
      expect.objectContaining({
        agentId: "a1",
        runId: "r1",
        trigger: "auto",
        attempt: 3,
        url: "https://x/hook",
        httpStatus: 503,
        ok: false,
        error: "upstream",
        signed: true,
      }),
    ]);
  });

  it("目标被策略拒绝也记一行(错误写明被拒)", async () => {
    const box = new OneJobOutbox({ runId: "r1", sessionId: "s1", attempts: 1 });
    const recs: { error?: string; ok: boolean }[] = [];
    const { d } = make(box, {
      deliver: async () => {
        throw new WebhookTargetRejected("指向内网");
      },
      recordDelivery: async (rec) => {
        recs.push(rec);
      },
    });
    await d.runOnce();
    expect(recs[0]).toMatchObject({ ok: false });
    expect(recs[0]?.error).toMatch(/目标被拒/);
    expect(box.marks).toEqual([{ state: "failed", nextAt: undefined }]);
  });

  it("记录写入永不返回:不拖住投递器,投递状态照常落下", { timeout: 10_000 }, async () => {
    const box = new OneJobOutbox({ runId: "r1", sessionId: "s1", attempts: 1 });
    const { d } = make(box, { recordDelivery: () => new Promise<never>(() => {}) });
    const t0 = Date.now();
    await d.runOnce();
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(box.marks).toEqual([{ state: "delivered", nextAt: undefined }]);
  });
});

describe("WebhookDispatcher:过期的投递结果", () => {
  it("写回被拒(令牌已失效):不抛错,只丢弃这次结果", async () => {
    const box = new OneJobOutbox({ runId: "r1", sessionId: "s1", attempts: 1 });
    box.accept = false;
    const { d } = make(box);
    await expect(d.runOnce()).resolves.toBe(1);
    expect(box.marks).toEqual([{ state: "delivered", nextAt: undefined }]);
  });
});
