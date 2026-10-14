// 第一个注册的用户成为管理员 —— 并发注册时也只有一个。真实 MySQL;未配置 OWA_TEST_DATABASE_URL 时跳过。
//
// 名额记在 platform_state.first_admin 上。测试库里已经有用户(名额已被占),
// 每个用例先腾出名额、结束时恢复原样。

import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { MysqlUserRepo } from "@/lib/modules/identity/adapters/mysql-user-repo";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn("[skip] 首个管理员的并发测试未运行 —— 需设置 OWA_TEST_DATABASE_URL");
  describe.skip("首个管理员(未配置测试库,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  const repo = new MysqlUserRepo(db);
  const rows = <T>(r: unknown) => ((r as [T[]])[0] ?? []) as T[];
  let saved: { v: string } | undefined;
  let created: string[] = [];

  beforeEach(async () => {
    saved = rows<{ v: string }>(
      await db.execute(sql`SELECT v FROM platform_state WHERE k = 'first_admin'`),
    )[0];
    await db.execute(sql`DELETE FROM platform_state WHERE k = 'first_admin'`);
    created = [];
  });
  afterEach(async () => {
    for (const id of created) await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
    await db.execute(sql`DELETE FROM platform_state WHERE k = 'first_admin'`);
    if (saved) {
      await db.execute(sql`INSERT INTO platform_state (k, v) VALUES ('first_admin', ${saved.v})`);
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  const newcomer = () => {
    const id = randomUUID().replace(/-/g, "").slice(0, 24);
    created.push(id);
    return { id, email: `first-${id}@x.test`, passwordHash: "h" };
  };

  describe("首个管理员(真实 MySQL)", () => {
    it("开放注册:12 人同时注册,恰好一个成为管理员,其余都是普通用户", async () => {
      const users = await Promise.all(
        Array.from({ length: 12 }, () => repo.registerSelf(newcomer(), { allowOthers: true })),
      );
      expect(users.every((u) => u !== null)).toBe(true);
      expect(users.filter((u) => u?.role === "admin")).toHaveLength(1);
    });

    it("未开放注册:同时注册只建出一个账号(就是那个管理员)", async () => {
      const users = await Promise.all(
        Array.from({ length: 8 }, () => repo.registerSelf(newcomer(), { allowOthers: false })),
      );
      const made = users.filter((u) => u !== null);
      expect(made).toHaveLength(1);
      expect(made[0]?.role).toBe("admin");
    });

    it("第一个人建号失败(邮箱已存在):名额随之回滚,下一个注册的仍成为管理员", async () => {
      const a = newcomer();
      const dup = { ...newcomer(), email: "" };
      await db.execute(
        sql`INSERT INTO users (id, email, password_hash, role) VALUES (${dup.id}, ${`dup-${dup.id}@x.test`}, 'h', 'user')`,
      );
      await expect(
        repo.registerSelf(
          {
            id: randomUUID().replace(/-/g, "").slice(0, 24),
            email: `dup-${dup.id}@x.test`,
            passwordHash: "h",
          },
          { allowOthers: true },
        ),
      ).rejects.toThrow();
      expect((await repo.registerSelf(a, { allowOthers: true }))?.role).toBe("admin");
    });
  });
}
