// 审批端口对真实 Redis 的行为测试。未配置 OWA_TEST_REDIS_URL 时跳过并说明。

import { randomUUID } from "node:crypto";
import { RedisApproval } from "@/lib/modules/approval/adapters/redis-approval";
import type { ApprovalRequest } from "@/lib/modules/approval/ports";
import { afterAll, describe, expect, it } from "vitest";

const URL = process.env.OWA_TEST_REDIS_URL;

if (!URL) {
  console.warn("[skip] RedisApproval 测试未运行 —— 需设置 OWA_TEST_REDIS_URL");
  // 【必须留一个跳过的 suite】否则整个文件没有任何测试,vitest 会报
  // "No test suite found" —— 一个只是缺依赖的文件显示成红色失败,
  // 而真正的失败就淹没在里面了。跳过要长得像跳过。
  describe.skip("RedisApproval(真实 Redis)(未配置 OWA_TEST_REDIS_URL,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  const approval = new RedisApproval(URL);
  afterAll(async () => {
    await approval.close();
  });

  const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => {
    const id = randomUUID().slice(0, 12);
    return {
      id,
      sessionId: `sess-${randomUUID().slice(0, 8)}`,
      toolName: "Bash",
      summary: "rm -rf ./build",
      reason: "命令包含高风险模式:rm -rf",
      createdAt: Date.now(),
      expiresAt: Date.now() + 5000,
      ...over,
    };
  };

  /** 等到条件成立,避免固定 sleep 带来的 flaky。 */
  async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000) {
    const start = Date.now();
    while (!(await cond())) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  // 这些用例做真实 Redis 往返 + 轮询,与构建等任务并发时会明显变慢。
  // 曾观察到一次未能复现的失败,故给足超时预算而非让它偶发地红。
  describe("RedisApproval", { timeout: 20_000 }, () => {
    it("批准后 request 兑现为 approved", async () => {
      const r = req();
      const pending = approval.request(r);
      // 等它真的落到 Redis,否则 resolve 会因为查不到而返回 false
      await waitFor(async () => (await approval.listPending(r.sessionId)).length === 1);

      expect(await approval.resolve(r.id, { decision: "approved", by: "admin" })).toBe(true);
      expect(await pending).toMatchObject({ decision: "approved", by: "admin" });
    });

    it("拒绝后兑现为 denied 并带出说明", async () => {
      const r = req();
      const pending = approval.request(r);
      await waitFor(async () => (await approval.listPending(r.sessionId)).length === 1);

      await approval.resolve(r.id, { decision: "denied", message: "太危险" });
      expect(await pending).toMatchObject({ decision: "denied", message: "太危险" });
    });

    it("【关键】没人审批时到点自动过期,不会永久挂住 worker", async () => {
      const r = req({ expiresAt: Date.now() + 1200 });
      const outcome = await approval.request(r);
      expect(outcome).toEqual({ decision: "expired" });
    });

    it("裁决后待审列表清空", async () => {
      const r = req();
      const pending = approval.request(r);
      await waitFor(async () => (await approval.listPending(r.sessionId)).length === 1);
      await approval.resolve(r.id, { decision: "approved" });
      await pending;
      await waitFor(async () => (await approval.listPending(r.sessionId)).length === 0);
      expect(await approval.listPending(r.sessionId)).toEqual([]);
    });

    it("待审列表能读到摘要与原因,审批人才判断得了", async () => {
      const r = req();
      const pending = approval.request(r);
      await waitFor(async () => (await approval.listPending(r.sessionId)).length === 1);
      const list = await approval.listPending(r.sessionId);
      expect(list[0]).toMatchObject({
        toolName: "Bash",
        summary: "rm -rf ./build",
        reason: expect.stringContaining("rm -rf"),
      });
      await approval.resolve(r.id, { decision: "approved" });
      await pending;
    });

    it("裁决不存在/已过期的请求返回 false,不误报成功", async () => {
      expect(await approval.resolve("never-existed", { decision: "approved" })).toBe(false);
    });

    it("同一会话的多条待审按时间排序", async () => {
      const sessionId = `sess-${randomUUID().slice(0, 8)}`;
      const a = req({ sessionId, createdAt: 1000, summary: "先" });
      const b = req({ sessionId, createdAt: 2000, summary: "后" });
      const pa = approval.request(a);
      const pb = approval.request(b);
      await waitFor(async () => (await approval.listPending(sessionId)).length === 2);

      expect((await approval.listPending(sessionId)).map((x) => x.summary)).toEqual(["先", "后"]);
      await approval.resolve(a.id, { decision: "approved" });
      await approval.resolve(b.id, { decision: "denied" });
      await Promise.all([pa, pb]);
    });

    it("不同会话的待审互不干扰", async () => {
      const a = req();
      const b = req();
      const pa = approval.request(a);
      const pb = approval.request(b);
      await waitFor(async () => (await approval.listPending(a.sessionId)).length === 1);
      await waitFor(async () => (await approval.listPending(b.sessionId)).length === 1);

      expect(await approval.listPending(a.sessionId)).toHaveLength(1);
      await approval.resolve(a.id, { decision: "approved" });
      await approval.resolve(b.id, { decision: "approved" });
      await Promise.all([pa, pb]);
    });

    it("空会话返回空列表", async () => {
      expect(await approval.listPending("no-such-session")).toEqual([]);
    });
  });

  // 运行被中止时,挂着的审批必须立刻收场。
  //
  // 曾经 request() 根本收不到 signal,等待只由自己的 10 分钟定时器驱动。于是运行
  // (被取消、或撞上 30 分钟墙钟上限)早已结束,而 waiter、定时器、Redis 里的
  // pending key 全都还在 —— worker 进程内按「被中止的运行数 × 10 分钟」持续累积。
  // 更要命的是界面上那条待审请求照常列出来,用户点批准还会拿到 200「已裁决」:
  // 他为一个不存在的运行授权了一次危险操作,审批记录与真实行为就此相反。
  describe("RedisApproval / 【泄漏回归】随运行中止而收场", () => {
    it("中止信号触发时立刻返回 expired,不等 10 分钟超时", async () => {
      const ac = new AbortController();
      const r = req();
      const p = approval.request(r, ac.signal);
      await waitFor(async () => (await approval.listPending(r.sessionId)).length === 1);

      const started = Date.now();
      ac.abort();
      expect(await p).toEqual({ decision: "expired" });
      // 真的是被信号叫醒的,而不是碰巧撞上超时
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("中止后待审记录被清掉 —— 界面上不该再显示它", async () => {
      const ac = new AbortController();
      const r = req();
      const p = approval.request(r, ac.signal);
      await waitFor(async () => (await approval.listPending(r.sessionId)).length === 1);

      ac.abort();
      await p;
      await waitFor(async () => (await approval.listPending(r.sessionId)).length === 0);
      expect(await approval.listPending(r.sessionId)).toEqual([]);
    });

    it("中止后再去裁决会明确失败 —— 不能对一个不存在的运行报告「已裁决」", async () => {
      const ac = new AbortController();
      const r = req();
      const p = approval.request(r, ac.signal);
      await waitFor(async () => (await approval.listPending(r.sessionId)).length === 1);

      ac.abort();
      await p;
      await waitFor(async () => (await approval.listPending(r.sessionId)).length === 0);
      expect(await approval.resolve(r.id, { decision: "approved" })).toBe(false);
    });

    it("传入的信号已经是 aborted 时直接收场,不留任何痕迹", async () => {
      const r = req();
      expect(await approval.request(r, AbortSignal.abort())).toEqual({ decision: "expired" });
      expect(await approval.listPending(r.sessionId)).toEqual([]);
    });

    it("没有中止时,正常裁决路径不受影响", async () => {
      const ac = new AbortController();
      const r = req();
      const p = approval.request(r, ac.signal);
      await waitFor(async () => (await approval.listPending(r.sessionId)).length === 1);
      expect(await approval.resolve(r.id, { decision: "approved" })).toBe(true);
      expect(await p).toMatchObject({ decision: "approved" });
    });
  });
}
