// 消耗汇总:按来源(api 与 invoke 合并)、智能体(已删除的归一组)、API Key(网页发起无 Key)、账号归组,
// 金额口径同月度额度检查(冻结中记冻结额,其余记净扣 + 欠额),本月合计 = monthUsageByAccount;
// 明细按同样的取值筛选。测试库共享:只看本用例写入的账号。
import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { agents, apiKeys, runCharges, runs, sessions, users } from "@/lib/db/schema";
import { afterAll, describe, expect, it } from "vitest";
import { summaryWindow, totalOf } from "../../domain/charge-summary";
import { monthWindowUtc } from "../../domain/run-charge";
import type { RunChargeFilter } from "../../run-charge-ports";
import { MysqlRunChargeQuery } from "../mysql-run-charge-query";

const url = process.env.OWA_TEST_DATABASE_URL;
const C = 1_000_000n;

if (!url) {
  describe.skip("charge summary: MySQL requires OWA_TEST_DATABASE_URL", () => {
    it("requires test database", () => {});
  });
} else {
  if (!/test/i.test(new URL(url).pathname)) throw new Error("Dedicated test database required");
  const { db, pool } = createDb(url);
  afterAll(() => pool.end());
  const query = new MysqlRunChargeQuery(db);
  const id = () => randomUUID().replace(/-/g, "").slice(0, 24);

  async function world() {
    const account = id();
    const other = id();
    for (const u of [account, other]) {
      await db
        .insert(users)
        .values({ id: u, email: `summary-${u}@example.test`, passwordHash: "x", role: "user" });
    }
    const agentA = id();
    const agentB = id();
    const gone = id(); // 会话指向的智能体已删除
    await db.insert(agents).values([
      { id: agentA, ownerId: account, name: "汇总甲", config: {} },
      { id: agentB, ownerId: account, name: "汇总乙", config: {} },
    ]);
    const key = id();
    await db
      .insert(apiKeys)
      .values({ id: key, ownerId: account, hashedKey: `h-${key}`, name: "对接 Key" });

    const now = Date.now();
    const month = monthWindowUtc(now);
    // 本月内的时刻(不越过当月边界,也不超过现在)
    const inMonth = (n: number) => new Date(Math.max(month.since, now - 60_000) + n);
    let seq = 0;
    async function run(
      who: string,
      agentId: string,
      source: string,
      charge: Partial<typeof runCharges.$inferInsert>,
      createdAt = inMonth(seq++),
    ) {
      const sessionId = id();
      const runId = id();
      await db.insert(sessions).values({ id: sessionId, agentId, workspaceDir: "/w", source });
      await db.insert(runs).values({ id: runId, sessionId, prompt: "p" });
      await db.insert(runCharges).values({
        runId,
        accountId: who,
        apiKeyId: null,
        mode: "live",
        reservedMicro: "0",
        reservationIds: [],
        estimatedMicro: "0",
        chargedMicro: "0",
        owedMicro: null,
        state: "settled",
        wouldReject: null,
        incomplete: 0,
        settledCostDigest: "d",
        settledAt: createdAt,
        createdAt,
        ...charge,
      });
      return runId;
    }

    const ids = {
      web: await run(account, agentA, "web", { chargedMicro: (10n * C).toString() }),
      // 冻结中:记冻结额,不记净扣
      open: await run(account, agentA, "web", {
        state: "open",
        reservedMicro: (300n * C).toString(),
        chargedMicro: null,
      }),
      api: await run(account, agentB, "api", { apiKeyId: key, chargedMicro: (5n * C).toString() }),
      // 欠款:净扣 30、欠 27.75
      invoke: await run(account, agentB, "invoke", {
        apiKeyId: key,
        state: "provisional",
        incomplete: 1,
        chargedMicro: (30n * C).toString(),
        owedMicro: "27750000",
      }),
      design: await run(account, gone, "design", { chargedMicro: (2n * C).toString() }),
      eval: await run(account, agentA, "eval", { chargedMicro: (1n * C).toString() }),
    };
    // 别的账号与上个月的,不算进本账号本月
    await run(other, agentA, "web", { chargedMicro: (99n * C).toString() });
    await run(
      account,
      agentA,
      "web",
      { chargedMicro: (77n * C).toString() },
      new Date(month.since - 1000),
    );
    return { account, other, agentA, agentB, key, ids, now, month };
  }

  describe("MySQL 消耗汇总", () => {
    it("按来源:api 与 invoke 合并;冻结中记冻结额;合计等于本月已用", async () => {
      const w = await world();
      const rows = await query.summarize({ accountId: w.account, ...w.month, by: "source" });
      const by = Object.fromEntries(rows.map((r) => [r.key, r]));
      expect(by.web).toMatchObject({
        runs: 2,
        chargedMicro: (10n * C).toString(),
        reservedMicro: (300n * C).toString(),
        usedMicro: (310n * C).toString(),
      });
      expect(by.api).toMatchObject({
        runs: 2,
        chargedMicro: (35n * C).toString(),
        owedMicro: "27750000",
        usedMicro: "62750000",
      });
      expect(by.design?.usedMicro).toBe((2n * C).toString());
      expect(by.eval?.usedMicro).toBe((1n * C).toString());
      expect(rows.map((r) => r.key)).toEqual(["web", "api", "design", "eval"]); // 合计从大到小
      const used = (await query.monthUsageByAccount(w.now, w.account)).get(w.account);
      expect(totalOf(rows).usedMicro).toBe(used?.toString());
    });

    it("按智能体:已删除的智能体归一组;按 Key:网页发起没有 Key;Key 带名称", async () => {
      const w = await world();
      const agentRows = await query.summarize({ accountId: w.account, ...w.month, by: "agent" });
      expect(
        Object.fromEntries(agentRows.map((r) => [r.key ?? "none", [r.name, r.runs, r.usedMicro]])),
      ).toEqual({
        [w.agentA]: ["汇总甲", 3, (311n * C).toString()],
        [w.agentB]: ["汇总乙", 2, "62750000"],
        none: [null, 1, (2n * C).toString()],
      });
      const keyRows = await query.summarize({ accountId: w.account, ...w.month, by: "key" });
      expect(Object.fromEntries(keyRows.map((r) => [r.key ?? "none", [r.name, r.runs]]))).toEqual({
        [w.key]: ["对接 Key", 2],
        none: [null, 4],
      });
    });

    it("全平台按账号:各账号分开,带邮箱", async () => {
      const w = await world();
      const rows = await query.summarize({ ...w.month, by: "account" });
      const mine = rows.filter((r) => r.key === w.account || r.key === w.other);
      expect(Object.fromEntries(mine.map((r) => [r.key, [r.name, r.runs, r.usedMicro]]))).toEqual({
        [w.account]: [`summary-${w.account}@example.test`, 6, "375750000"],
        [w.other]: [`summary-${w.other}@example.test`, 1, (99n * C).toString()],
      });
    });

    it("上月窗口只含上个月的运行", async () => {
      const w = await world();
      const last = summaryWindow("last_month", w.now);
      const rows = await query.summarize({ accountId: w.account, ...last, by: "source" });
      expect(rows).toEqual([
        expect.objectContaining({ key: "web", runs: 1, usedMicro: (77n * C).toString() }),
      ]);
    });

    it("明细按汇总同样的取值筛选", async () => {
      const w = await world();
      const list = async (filter: RunChargeFilter) =>
        (
          await query.listByAccount(w.account, { limit: 50, filter: { ...w.month, ...filter } })
        ).items
          .map((i) => i.runId)
          .sort();
      expect(await list({ source: "api" })).toEqual([w.ids.api, w.ids.invoke].sort());
      expect(await list({ agentId: null })).toEqual([w.ids.design]);
      expect(await list({ agentId: w.agentB })).toEqual([w.ids.api, w.ids.invoke].sort());
      expect(await list({ apiKeyId: null })).toEqual(
        [w.ids.web, w.ids.open, w.ids.design, w.ids.eval].sort(),
      );
      expect(await list({ apiKeyId: w.key })).toEqual([w.ids.api, w.ids.invoke].sort());
      // 不带窗口时含上个月的那条
      const all = await query.listByAccount(w.account, { limit: 50, filter: { source: "web" } });
      expect(all.items).toHaveLength(3);
    });
  });
}
