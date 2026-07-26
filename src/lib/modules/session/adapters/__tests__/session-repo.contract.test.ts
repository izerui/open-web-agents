// 同一套契约,两个 adapter 都必须通过。
// MySQL 用例需要真实数据库:未配置 OWA_TEST_DATABASE_URL 时跳过并明确说明(不静默假过)。

import { createDb } from "@/lib/db/client";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import { MysqlSessionRepo } from "@/lib/modules/session/adapters/mysql-session-repo";
import { sessionRepoContract } from "@/lib/modules/session/ports.contract";
import { afterAll } from "vitest";

sessionRepoContract("InMemorySessionRepo", {
  makeRepo: async () => new InMemorySessionRepo(),
});

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

/** 从连接串里取库名,用于自证"这是测试库"。 */
function databaseNameOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
}

if (!TEST_DB_URL) {
  console.warn("[skip] SessionRepo 的 MySQL 契约未运行 —— 需设置 OWA_TEST_DATABASE_URL 指向测试库");
} else {
  const dbName = databaseNameOf(TEST_DB_URL);
  const { db, pool } = createDb(TEST_DB_URL);
  const repo = new MysqlSessionRepo(db);

  sessionRepoContract("MysqlSessionRepo(真实 MySQL)", {
    makeRepo: async () => {
      // 传库名自证:指到非测试库时这里会抛错,而不是默默把开发数据删掉
      await repo._truncate(dbName);
      return repo;
    },
    // 这个上限只存在于 SQL 实现里 —— 内存实现无上限,单测它永远发现不了挤占问题
    listLimit: 100,
  });

  afterAll(async () => {
    await repo._truncate(dbName);
    await pool.end();
  });
}
