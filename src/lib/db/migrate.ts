// CJS 包,只有 default 导出 —— 具名 import 在 ESM 下会直接抛 SyntaxError(同 src/worker.ts)
import nextEnv from "@next/env";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createDb } from "./client";

export async function runMigrations(databaseUrl: string): Promise<void> {
  const { db, pool } = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  /**
   * 【必须先加载 .env】`pnpm db:migrate` 是裸 tsx 进程,Next 只会给 web 进程自动加载
   * .env / .env.local。少了这一步,按 README 配好 .env.local 之后迁移直接报缺变量。
   * 已经在进程环境里的变量优先(CI、容器的 migrate 服务、测试脚本都是这么传的),不会被文件覆盖。
   *
   * 【只要数据库连接串】迁移不碰 Redis 等其它配置,不该因为它们缺失而拒绝运行。
   */
  nextEnv.loadEnvConfig(process.cwd(), false);
  const databaseUrl = process.env.OWA_DATABASE_URL;
  if (!databaseUrl?.startsWith("mysql://")) {
    console.error("需要 OWA_DATABASE_URL(mysql://...),可写在 .env.local 里");
    process.exit(1);
  }
  runMigrations(databaseUrl)
    .then(() => {
      console.log("migrations applied");
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
