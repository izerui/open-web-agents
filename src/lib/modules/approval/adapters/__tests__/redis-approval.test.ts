// 审批端口对真实 Redis 的行为测试。未配置 OWA_TEST_REDIS_URL 时跳过并说明。

import { randomUUID } from "node:crypto";
import { RedisApproval } from "@/lib/modules/approval/adapters/redis-approval";
import { type ApprovalRequest, ApprovalUnavailable } from "@/lib/modules/approval/ports";
import Redis from "ioredis";
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

  /**
   * 一个"连接在第一条命令之后就断了"的审批方:第一条 Redis 命令成功,之后全部失败。
   * 用来模拟裁决落地后进程退出 / 网络中断,广播因此丢失。
   */
  async function flakyApprover(): Promise<{
    approver: RedisApproval;
    restore: () => Promise<void>;
  }> {
    const approver = new RedisApproval(URL as string);
    await approver.listPending("warm-up"); // 先把连接建好,握手命令不算在故障预算里
    const cmd = (approver as unknown as { cmd: Redis }).cmd;
    const send = cmd.sendCommand.bind(cmd);
    let sent = 0;
    cmd.sendCommand = ((c: Parameters<Redis["sendCommand"]>[0]) => {
      if (sent++ >= 1) {
        c.reject(new Error("connection lost"));
        return c.promise;
      }
      return send(c);
    }) as Redis["sendCommand"];
    return {
      approver,
      restore: async () => {
        cmd.sendCommand = send;
        await approver.close();
      },
    };
  }

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
    it("提问:待回答带着题目与 toolUseId 列出;回答随裁决跨进程带回等待方", async () => {
      const worker = new RedisApproval(URL as string);
      const web = new RedisApproval(URL as string);
      try {
        const q = req({
          toolName: "AskUserQuestion",
          toolUseId: "toolu_q",
          questions: [{ question: "格式?", options: [{ label: "PDF" }] }],
        });
        const waiting = worker.request(q);
        await waitFor(async () => (await web.listPending(q.sessionId)).length === 1);
        expect((await web.listPending(q.sessionId))[0]).toMatchObject({
          toolUseId: "toolu_q",
          questions: [{ question: "格式?" }],
        });
        expect(
          await web.resolve(q.id, { decision: "approved", by: "u1", answers: { "格式?": "Word" } }),
        ).toBe(true);
        expect(await waiting).toEqual({
          decision: "approved",
          by: "u1",
          answers: { "格式?": "Word" },
        });
      } finally {
        await worker.close();
        await web.close();
      }
    });

    it("【裁决不丢】审批方的连接在第一条命令之后就断了:裁决照样送达等待方", async () => {
      // 故障模型与实现无关:审批方发出的第一条 Redis 命令成功,之后的全部失败
      // (进程退出 / 网络中断)。曾经的实现第一条是 GETDEL —— 待审被删,
      // 紧接着的 SET 裁决失败,裁决就此丢失,等待方只能等到超时被拒。
      const r = req({ expiresAt: Date.now() + 8_000 });
      const pending = approval.request(r);
      await waitFor(async () => (await approval.listPending(r.sessionId)).length === 1);

      const { approver, restore } = await flakyApprover();

      // 裁决已原子落地,广播失败不该让审批人以为没批成
      expect(await approver.resolve(r.id, { decision: "approved", by: "admin" })).toBe(true);
      expect(await pending).toMatchObject({ decision: "approved", by: "admin" });
      await restore();
    });

    it("【裁决不丢】最后一次轮询之后、到期之前批准,且广播丢失:到期收尾采用已落地的批准", async () => {
      // 轮询间隔远大于审批有效期 —— 整个有效期都是"最后一次轮询之后"的窗口,
      // 裁决只能靠到期那一刻的原子收尾拿到
      const waiter = new RedisApproval(URL, { pollMs: 60_000 });
      const start = Date.now();
      const r = req({ expiresAt: start + 1500 });
      const pending = waiter.request(r);
      await waitFor(async () => (await waiter.listPending(r.sessionId)).length === 1);

      const { approver, restore } = await flakyApprover();
      expect(await approver.resolve(r.id, { decision: "approved", by: "admin" })).toBe(true);

      // 曾经这里是 expired:超时回调直接判过期,随后 cleanup 把已落地的 approved 一起删了
      expect(await pending).toMatchObject({ decision: "approved", by: "admin" });
      // 确实是在到期收尾时拿到的,不是靠广播或轮询
      expect(Date.now() - start).toBeGreaterThanOrEqual(1400);
      await restore();
      await waiter.close();
    });

    it("【裁决不丢】批准已落地、广播丢失、到期时等待方 Redis 不可用:有界结束,报基础设施错误,批准记录保留", async () => {
      const waiter = new RedisApproval(URL, { pollMs: 60_000, commandTimeoutMs: 300 });
      const start = Date.now();
      const r = req({ expiresAt: start + 1500 });
      const pending = waiter.request(r);
      // 先挂上 catch,免得断言之前出现未处理的拒绝
      const settled = pending.then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      await waitFor(async () => (await waiter.listPending(r.sessionId)).length === 1);

      // 批准落地,广播丢失
      const { approver, restore } = await flakyApprover();
      expect(await approver.resolve(r.id, { decision: "approved", by: "admin" })).toBe(true);
      await restore();

      // 等待方的 Redis 在到期收尾时不可用:maxRetriesPerRequest=null 下命令进离线队列、
      // 永不返回。只让 EVAL 卡住、其它命令照常 —— 这样若实现在失败后仍去清理,
      // 删除真的会发生,下面"批准记录保留"的断言才有意义
      const cmd = (waiter as unknown as { cmd: Redis }).cmd;
      const send = cmd.sendCommand.bind(cmd);
      cmd.sendCommand = ((c: Parameters<Redis["sendCommand"]>[0]) => {
        if ((c as unknown as { name: string }).name === "eval") return c.promise; // 永不结束
        return send(c);
      }) as Redis["sendCommand"];

      const result = await settled;
      // 有界结束:到期(1.5s)+ 命令上限(0.3s),而不是一直挂着
      expect(Date.now() - start).toBeLessThan(3_000);
      // 明确报基础设施错误,不冒充业务上的超时拒绝
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.e).toBeInstanceOf(ApprovalUnavailable);

      // 批准记录没有被删,留给 TTL 回收
      await new Promise((res) => setTimeout(res, 200));
      const raw = new Redis(URL);
      expect(JSON.parse((await raw.get(`owa:approval:decided:${r.id}`)) ?? "null")).toMatchObject({
        decision: "approved",
        by: "admin",
      });
      expect(await raw.pttl(`owa:approval:decided:${r.id}`)).toBeGreaterThan(0);
      await raw.quit();

      cmd.sendCommand = send;
      await waiter.close();
    });

    it("【有界返回】裁决 EVAL 成功、广播永不兑现:resolve 有界返回成功,等待方照样拿到批准", async () => {
      const r = req({ expiresAt: Date.now() + 10_000 });
      const pending = approval.request(r);
      await waitFor(async () => (await approval.listPending(r.sessionId)).length === 1);

      // 审批方:EVAL 正常落地,之后的 PUBLISH 进离线队列、永不返回
      const approver = new RedisApproval(URL, { commandTimeoutMs: 300 });
      await approver.listPending("warm-up");
      const cmd = (approver as unknown as { cmd: Redis }).cmd;
      const send = cmd.sendCommand.bind(cmd);
      cmd.sendCommand = ((c: Parameters<Redis["sendCommand"]>[0]) => {
        if ((c as unknown as { name: string }).name === "publish") return c.promise; // 永不结束
        return send(c);
      }) as Redis["sendCommand"];

      const start = Date.now();
      expect(await approver.resolve(r.id, { decision: "approved", by: "admin" })).toBe(true);
      expect(Date.now() - start).toBeLessThan(1_500);
      // 广播没发出去,等待方靠轮询拿到已落地的批准
      expect(await pending).toMatchObject({ decision: "approved", by: "admin" });

      cmd.sendCommand = send;
      await approver.close();
    });

    it("【有界返回】读待审列表时 Redis 不可用:以 ApprovalUnavailable 有界失败", async () => {
      const reader = new RedisApproval(URL, { commandTimeoutMs: 300 });
      await reader.listPending("warm-up");
      const cmd = (reader as unknown as { cmd: Redis }).cmd;
      const send = cmd.sendCommand.bind(cmd);
      cmd.sendCommand = ((c: Parameters<Redis["sendCommand"]>[0]) =>
        c.promise) as Redis["sendCommand"];

      const start = Date.now();
      await expect(reader.listPending("any")).rejects.toBeInstanceOf(ApprovalUnavailable);
      expect(Date.now() - start).toBeLessThan(1_500);

      cmd.sendCommand = send;
      await reader.close();
    });

    it("登记待审时 Redis 不可用:有界失败,报基础设施错误", async () => {
      const waiter = new RedisApproval(URL, { commandTimeoutMs: 300 });
      await waiter.listPending("warm-up");
      const cmd = (waiter as unknown as { cmd: Redis }).cmd;
      const send = cmd.sendCommand.bind(cmd);
      cmd.sendCommand = ((c: Parameters<Redis["sendCommand"]>[0]) =>
        c.promise) as Redis["sendCommand"];

      const start = Date.now();
      await expect(waiter.request(req())).rejects.toBeInstanceOf(ApprovalUnavailable);
      expect(Date.now() - start).toBeLessThan(2_000);

      cmd.sendCommand = send;
      await waiter.close();
    });

    it("到期时没有裁决:判过期,且待审被关闭,之后的批准一律落空", async () => {
      const waiter = new RedisApproval(URL, { pollMs: 60_000 });
      const r = req({ expiresAt: Date.now() + 1000 });
      expect(await waiter.request(r)).toEqual({ decision: "expired" });
      expect(await approval.resolve(r.id, { decision: "approved" })).toBe(false);
      expect(await approval.listPending(r.sessionId)).toEqual([]);
      await waiter.close();
    });

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

  describe("本会话内同类授权(真实 Redis)", { timeout: 20_000 }, () => {
    it("一次授权多类(复合命令):全部写入", async () => {
      const r = req();
      const p = approval.request(r);
      await new Promise((ok) => setTimeout(ok, 50));
      await approval.resolve(
        r.id,
        { decision: "approved" },
        {
          sessionId: r.sessionId,
          grants: [
            { key: "bash:curl", label: "含「curl」的命令", at: 1 },
            { key: "bash:rm -rf", label: "含「rm -rf」的命令", at: 1 },
          ],
        },
      );
      await p;
      expect((await approval.grants(r.sessionId)).map((g) => g.key).sort()).toEqual([
        "bash:curl",
        "bash:rm -rf",
      ]);
    });

    const grantOf = (key: string) => ({ key, label: `类别 ${key}`, by: "u1", at: Date.now() });

    it("批准并授权:裁决与授权一起落地;撤销后没有了", async () => {
      const r = req({ scopes: [{ key: "bash:curl", label: "含「curl」的命令" }] });
      const p = approval.request(r);
      await new Promise((ok) => setTimeout(ok, 50));
      expect(
        await approval.resolve(
          r.id,
          { decision: "approved", by: "u1" },
          {
            sessionId: r.sessionId,
            grants: [grantOf("bash:curl")],
          },
        ),
      ).toBe(true);
      expect(await p).toMatchObject({ decision: "approved" });
      expect((await approval.grants(r.sessionId)).map((g) => g.key)).toEqual(["bash:curl"]);
      expect(await approval.revokeGrant(r.sessionId, "bash:curl")).toBe(true);
      expect(await approval.grants(r.sessionId)).toEqual([]);
      expect(await approval.revokeGrant(r.sessionId, "bash:curl")).toBe(false);
    });

    it("待审已失效(没批成):不会留下授权", async () => {
      const r = req();
      // 从未登记的待审 = 已过期 / 已被别人裁决
      expect(
        await approval.resolve(
          r.id,
          { decision: "approved" },
          {
            sessionId: r.sessionId,
            grants: [grantOf("bash:curl")],
          },
        ),
      ).toBe(false);
      expect(await approval.grants(r.sessionId)).toEqual([]);
    });

    it("拒绝时即使带了授权也不写入", async () => {
      const r = req();
      const p = approval.request(r);
      await new Promise((ok) => setTimeout(ok, 50));
      expect(
        await approval.resolve(
          r.id,
          { decision: "denied", message: "不行" },
          {
            sessionId: r.sessionId,
            grants: [grantOf("bash:curl")],
          },
        ),
      ).toBe(true);
      expect(await p).toMatchObject({ decision: "denied", message: "不行" });
      expect(await approval.grants(r.sessionId)).toEqual([]);
    });

    it("授权按会话隔离", async () => {
      const a = req({ scopes: [{ key: "tool:Write", label: "工具 Write" }] });
      const p = approval.request(a);
      await new Promise((ok) => setTimeout(ok, 50));
      await approval.resolve(
        a.id,
        { decision: "approved" },
        {
          sessionId: a.sessionId,
          grants: [grantOf("tool:Write")],
        },
      );
      await p;
      expect(await approval.grants(`other-${a.sessionId}`)).toEqual([]);
    });
  });
}
