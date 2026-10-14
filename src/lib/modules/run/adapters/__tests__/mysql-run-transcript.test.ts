// 本轮在 transcript 里的范围随 SDK 会话一起落库、列表时带出。未配置 OWA_TEST_DATABASE_URL 时跳过。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] transcript 范围的 MySQL 测试未运行 —— 需设置 OWA_TEST_DATABASE_URL");
  describe.skip("transcript 范围(未配置测试库,已跳过)", () => {
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

  describe("transcript 范围(真实 MySQL)", () => {
    it("记下范围后列表带出;没记范围的旧行为 undefined", async () => {
      const sessionId = `s-tr-${randomUUID().slice(0, 8)}`;
      const withRange = randomUUID().replace(/-/g, "").slice(0, 24);
      const legacy = randomUUID().replace(/-/g, "").slice(0, 24);
      await repo.create({ id: withRange, sessionId, prompt: "一" });
      await repo.create({ id: legacy, sessionId, prompt: "二" });
      // 测试库被并行的测试文件共用:待执行的行会被并发用例里的 worker 认领走、打乱它的计数。
      // 一建好就落终态,结束时删掉
      await db.execute(sql`UPDATE runs SET status = 'success' WHERE session_id = ${sessionId}`);
      try {
        await repo.setSdkSessionId(withRange, "sdk-same", { first: "u-first", last: "u-last" });
        await repo.setSdkSessionId(legacy, "sdk-same");

        const rows = await repo.listBySession(sessionId);
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get(withRange)).toMatchObject({
          sdkSessionId: "sdk-same",
          transcriptRange: { first: "u-first", last: "u-last" },
        });
        expect(byId.get(legacy)?.sdkSessionId).toBe("sdk-same");
        expect(byId.get(legacy)?.transcriptRange).toBeUndefined();
      } finally {
        await db.execute(sql`DELETE FROM runs WHERE session_id = ${sessionId}`);
      }
    });
  });
}
