// 回调投递的认领令牌,对真实 MySQL + 真实投递器。未配置 OWA_TEST_DATABASE_URL 时跳过。
//
// 场景:A 投递卡住 → 租约过期后 B 接手并判失败 → 用户手动重发(202)→ A 的旧结果(成功)
// 才返回。旧结果不能把已受理的重发覆盖成 delivered —— 否则重发永远不会执行。
//
// 时间全部注入(负数时刻),既让 A 的租约确定性地过期,也保证只会认领到本测试这一行 ——
// 测试库里其他行的 next_at 都不小于 0。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { WebhookDispatcher } from "@/lib/modules/integration/application/webhook-dispatcher";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] 回调认领令牌的 MySQL 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL");
  describe.skip("回调认领令牌(未配置测试库,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  const repo = new MysqlRunRepo(db);
  afterAll(async () => {
    await pool.end();
  });

  async function state(id: string) {
    const r = await db.execute(
      sql`SELECT webhook_state AS s, webhook_next_at AS n, webhook_lease AS l FROM runs WHERE id = ${id}`,
    );
    const row = ((r as unknown as [Record<string, unknown>[]])[0] ?? [])[0];
    return { s: row?.s, n: row?.n === null ? null : Number(row?.n), l: row?.l };
  }

  describe("回调认领令牌(真实 MySQL)", () => {
    it(
      "A 卡住 → 租约过期 B 判失败 → 手动重发 → A 的旧成功结果被丢弃,新一轮仍待投且可被认领",
      { timeout: 30_000 },
      async () => {
        const id = randomUUID().replace(/-/g, "").slice(0, 24);
        await repo.create({ id, sessionId: "s-lease", prompt: "t" });
        await db.execute(
          sql`UPDATE runs SET status = 'success', webhook_state = 'pending', webhook_next_at = -20000, webhook_attempts = 0 WHERE id = ${id}`,
        );
        const base = {
          outbox: repo,
          loadTarget: async () => ({ agentId: "a", url: "https://hook.example.com/in" }),
          loadPayload: async () => ({ taskId: id, status: "success" }),
        };

        let inFlight!: () => void;
        let releaseA!: () => void;
        const aInFlight = new Promise<void>((r) => {
          inFlight = r;
        });
        const aGate = new Promise<void>((r) => {
          releaseA = r;
        });
        const A = new WebhookDispatcher(
          {
            ...base,
            deliver: async () => {
              inFlight();
              await aGate; // 卡住
              return { delivered: true, attempts: 1, lastStatus: 200 };
            },
            now: () => -10_000,
          },
          { leaseMs: 100, batch: 1 },
        );
        const B = new WebhookDispatcher(
          {
            ...base,
            deliver: async () => ({ delivered: false, attempts: 1, lastStatus: 400 }),
            now: () => -9_000, // A 的租约在 -9900 到期
          },
          { leaseMs: 100, batch: 1 },
        );

        try {
          const aDone = A.runOnce();
          await aInFlight;
          expect((await state(id)).s).toBe("delivering");

          expect(await B.runOnce()).toBe(1); // B 接手,对方 400 → failed
          expect((await state(id)).s).toBe("failed");

          expect(await repo.requeueWebhook(id, -8_500)).toBe(true); // 用户点重发,接口回 202
          expect(await state(id)).toEqual({ s: "pending", n: -8_500, l: null });

          releaseA(); // A 的旧结果(成功)这才回来
          await aDone;
          // 旧结果被丢弃:重发仍待投
          expect(await state(id)).toEqual({ s: "pending", n: -8_500, l: null });

          // 新一轮可被认领,拿到的是新令牌
          const next = await repo.claimWebhook(-8_000, 60_000);
          expect(next?.runId).toBe(id);
          expect(next?.attempts).toBe(1);
          expect(await repo.markWebhook(id, next?.lease ?? "", "delivered")).toBe(true);
        } finally {
          // 收尾:落到终态,免得负数时刻的待投行被别的测试(用真实时钟认领)拿到
          await db.execute(
            sql`UPDATE runs SET webhook_state = 'delivered', webhook_next_at = NULL, webhook_lease = NULL WHERE id = ${id}`,
          );
        }
      },
    );

    it(
      "A 的旧结果在新一轮 C 已认领(又回到 delivering)之后才回来:只有令牌挡得住",
      { timeout: 30_000 },
      async () => {
        const id = randomUUID().replace(/-/g, "").slice(0, 24);
        await repo.create({ id, sessionId: "s-lease", prompt: "t" });
        await db.execute(
          sql`UPDATE runs SET status = 'success', webhook_state = 'pending', webhook_next_at = -40000, webhook_attempts = 0 WHERE id = ${id}`,
        );
        try {
          const a = await repo.claimWebhook(-39_000, 100); // A 认领,租约 -38900 到期
          expect(a?.runId).toBe(id);
          const b = await repo.claimWebhook(-38_000, 100); // 租约过期,B 接手
          expect(b?.runId).toBe(id);
          expect(await repo.markWebhook(id, b?.lease ?? "", "failed")).toBe(true);
          expect(await repo.requeueWebhook(id, -37_500)).toBe(true); // 重发
          const c = await repo.claimWebhook(-37_000, 60_000); // 新一轮 C 认领:又是 delivering
          expect(c?.runId).toBe(id);
          expect((await state(id)).s).toBe("delivering");

          // A 的旧结果这时才回来:状态是 delivering,但令牌不是它的 —— 必须被拒
          expect(await repo.markWebhook(id, a?.lease ?? "", "delivered")).toBe(false);
          expect(await state(id)).toEqual({ s: "delivering", n: -37_000 + 60_000, l: c?.lease });
          // C 自己的结果照常写回
          expect(await repo.markWebhook(id, c?.lease ?? "", "delivered")).toBe(true);
        } finally {
          await db.execute(
            sql`UPDATE runs SET webhook_state = 'delivered', webhook_next_at = NULL, webhook_lease = NULL WHERE id = ${id}`,
          );
        }
      },
    );

    it("令牌不符或状态已不是 delivering:写回被拒", async () => {
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      await repo.create({ id, sessionId: "s-lease", prompt: "t" });
      await db.execute(
        sql`UPDATE runs SET status = 'success', webhook_state = 'pending', webhook_next_at = -30000 WHERE id = ${id}`,
      );
      try {
        const job = await repo.claimWebhook(-29_000, 60_000);
        expect(job?.runId).toBe(id);
        expect(await repo.markWebhook(id, "not-my-lease", "delivered")).toBe(false);
        expect(await repo.markWebhook(id, job?.lease ?? "", "failed")).toBe(true);
        // 已落 failed:同一令牌再写也不行
        expect(await repo.markWebhook(id, job?.lease ?? "", "delivered")).toBe(false);
        expect((await state(id)).s).toBe("failed");
      } finally {
        await db.execute(
          sql`UPDATE runs SET webhook_state = 'delivered', webhook_next_at = NULL, webhook_lease = NULL WHERE id = ${id}`,
        );
      }
    });
  });
}
