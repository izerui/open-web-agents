// 确保目标数据库存在(不存在就建)。
//
// 为什么不用 `mysql` 命令行:GitHub 的 ubuntu 运行器【默认不带 mysql 客户端】,
// 而 mysql2 本来就是项目依赖。少依赖一个不受控的外部命令,
// 就少一个"本地好好的、CI 上莫名其妙红了"的来源。
//
// 用法:node scripts/ensure-databases.mjs owa owa_test
//   连接信息取自 OWA_DATABASE_URL(库名部分被忽略 —— 目标库可能还不存在)。

import mysql from "mysql2/promise";

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("用法:node scripts/ensure-databases.mjs <db> [db...]");
  process.exit(1);
}

const raw = process.env.OWA_DATABASE_URL;
if (!raw) {
  console.error("需要 OWA_DATABASE_URL");
  process.exit(1);
}

const u = new URL(raw);
// 库名不能带进连接 —— 要建的库此刻还不存在
const conn = await mysql.createConnection({
  host: u.hostname,
  port: Number(u.port || 3306),
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
});

try {
  for (const name of names) {
    // 库名只允许字母数字下划线:它要拼进 DDL,不能走参数绑定
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      throw new Error(`非法库名:${name}`);
    }
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    console.log(`✓ 数据库就绪:${name}`);
  }
} finally {
  await conn.end();
}
