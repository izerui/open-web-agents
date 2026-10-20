// 跨账号的待核对(暂记)列表:原因归类、筛选、分页、账号邮箱。只读。
// 测试库是共享的(别的用例也会写暂记):断言只看本用例写入的账号。
import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { runCharges, users } from "@/lib/db/schema";
import { afterAll, describe, expect, it } from "vitest";
import type { PendingChargeItem } from "../../run-charge-ports";
import { MysqlRunChargeQuery } from "../mysql-run-charge-query";

const url = process.env.OWA_TEST_DATABASE_URL;

if (!url) {
  describe.skip("pending query: MySQL requires OWA_TEST_DATABASE_URL", () => {
    it("requires test database", () => {});
  });
} else {
  if (!/test/i.test(new URL(url).pathname)) throw new Error("Dedicated test database required");
  const { db, pool } = createDb(url);
  afterAll(() => pool.end());
  const query = new MysqlRunChargeQuery(db);

  const row = (
    accountId: string,
    over: Partial<typeof runCharges.$inferInsert> & { createdAt: Date },
  ): typeof runCharges.$inferInsert => ({
    runId: randomUUID(),
    accountId,
    apiKeyId: null,
    mode: "live",
    reservedMicro: "0",
    reservationIds: [],
    estimatedMicro: "0",
    chargedMicro: "0",
    owedMicro: null,
    state: "provisional",
    wouldReject: null,
    incomplete: 1,
    settledCostDigest: "d",
    settledAt: over.createdAt,
    ...over,
  });

  /** 翻完所有页,只留本用例的账号 */
  async function all(
    mine: Set<string>,
    opts: Parameters<MysqlRunChargeQuery["listPending"]>[0],
  ): Promise<PendingChargeItem[]> {
    const out: PendingChargeItem[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 500; i++) {
      const page = await query.listPending({ ...opts, cursor });
      out.push(...page.items.filter((x) => mine.has(x.accountId)));
      if (!page.nextCursor) return out;
      cursor = page.nextCursor;
    }
    throw new Error("分页没有结束");
  }

  describe("MySQL 待核对列表", () => {
    it("按原因归类、跨账号列出,只含暂记;可按原因、计费模式筛选;分页不重不漏;带账号邮箱", async () => {
      const a = randomUUID();
      const b = randomUUID();
      const email = `pending-${a}@example.test`;
      await db.insert(users).values({ id: a, email, passwordHash: "x", role: "user" } as never);
      const t = Date.now();
      const at = (n: number) => new Date(t - n * 1000);
      const rows = [
        // 欠款:实际 57.75,扣到 30
        row(a, {
          createdAt: at(1),
          estimatedMicro: "57750000",
          chargedMicro: "30000000",
          owedMicro: "27750000",
        }),
        // 已扣 92.4、费用修正为 69.3 但仍不完整:不算多扣(未确认应扣减少),归无法完整计价
        row(b, { createdAt: at(2), estimatedMicro: "69300000", chargedMicro: "92400000" }),
        // 用量未知:结算时没有花费
        row(a, { createdAt: at(3), settledCostDigest: null }),
        // 无法完整计价:能算的 23.1 已扣
        row(b, { createdAt: at(4), estimatedMicro: "23100000", chargedMicro: "23100000" }),
        // 试算的无法完整计价
        row(a, { createdAt: at(5), mode: "trial", estimatedMicro: "1000000", chargedMicro: "0" }),
        // 已结清、冻结中的不列
        row(a, { createdAt: at(6), state: "settled", incomplete: 0 }),
        row(b, { createdAt: at(7), state: "open", reservedMicro: "300000000" }),
      ];
      await db.insert(runCharges).values(rows);
      const mine = new Set([a, b]);

      const listed = await all(mine, { limit: 2 });
      expect(listed.map((x) => [x.runId, x.reason, x.mode])).toEqual([
        [rows[0]?.runId, "owed", "live"],
        [rows[1]?.runId, "unpriced", "live"],
        [rows[2]?.runId, "usage_unknown", "live"],
        [rows[3]?.runId, "unpriced", "live"],
        [rows[4]?.runId, "unpriced", "trial"],
      ]);
      expect(listed[0]).toMatchObject({
        accountId: a,
        accountEmail: email,
        chargedMicro: "30000000",
        owedMicro: "27750000",
        estimatedMicro: "57750000",
        state: "provisional",
      });
      expect(listed[1]?.accountEmail).toBeNull(); // b 没有账号行

      expect((await all(mine, { limit: 50, reason: "unpriced" })).map((x) => x.runId)).toEqual([
        rows[1]?.runId,
        rows[3]?.runId,
        rows[4]?.runId,
      ]);
      expect(
        (await all(mine, { limit: 50, reason: "unpriced", mode: "live" })).map((x) => x.runId),
      ).toEqual([rows[1]?.runId, rows[3]?.runId]);
      expect((await all(mine, { limit: 50, mode: "trial" })).map((x) => x.runId)).toEqual([
        rows[4]?.runId,
      ]);

      // 统计是全库的:至少包含本用例写入的
      const counts = await query.pendingCounts();
      expect(counts.owed).toBeGreaterThanOrEqual(1);
      expect(counts.usage_unknown).toBeGreaterThanOrEqual(1);
      expect(counts.unpriced).toBeGreaterThanOrEqual(3);
      // 试算不扣钱,不会有欠款
      expect((await query.pendingCounts("trial")).owed).toBe(0);
    });

    it("cursor 无效:报错", async () => {
      await expect(query.listPending({ limit: 10, cursor: "bad" })).rejects.toThrow(/cursor/);
    });
  });
}
