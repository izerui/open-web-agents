// 同一套契约,两个 adapter 都必须通过。
// MySQL 用例需要真实数据库:未配置 OWA_TEST_DATABASE_URL 时跳过并明确说明(不静默假过)。

import { createDb } from "@/lib/db/client";
import { InMemoryRunRepo } from "@/lib/modules/run/adapters/in-memory-run-repo";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { runRepoContract } from "@/lib/modules/run/ports.contract";
import { afterAll } from "vitest";

runRepoContract("InMemoryRunRepo", {
  makeRepo: async () => new InMemoryRunRepo(),
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

if (TEST_DB_URL) {
  const dbName = databaseNameOf(TEST_DB_URL);
  const { db, pool } = createDb(TEST_DB_URL);
  const repo = new MysqlRunRepo(db);

  runRepoContract("MysqlRunRepo(真实 MySQL)", {
    makeRepo: async () => {
      // 传库名自证:指到非测试库时这里会抛错,而不是默默把开发数据删掉
      await repo._truncate(dbName);
      return repo;
    },
  });

  afterAll(async () => {
    await repo._truncate(dbName);
    await pool.end();
  });
} else {
  console.warn(
    "[skip] MysqlRunRepo 契约测试未运行 —— 需设置 OWA_TEST_DATABASE_URL 指向【专用测试库】(库名须含 test)",
  );
}
