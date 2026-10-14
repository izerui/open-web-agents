import { sql } from "drizzle-orm";
import { type MySql2Database, drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema";
import { singleFlight } from "./single-flight";

export type Db = MySql2Database<typeof schema>;

/** 建连接池。调用方(container / 测试)负责生命周期。 */
export function createDb(databaseUrl: string): { db: Db; pool: mysql.Pool } {
  const pool = mysql.createPool({
    uri: databaseUrl,
    connectionLimit: 10,
    // 队列认领要比较 bigint 时间戳,按字符串取回会引入隐式转换
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  return { db: drizzle(pool, { schema, mode: "default" }), pool };
}

/**
 * 健康检查共用一次在途查询。路由的等待超时不会取消底层查询,
 * 只有查询真正结束后才发起下一次,避免反复探测积压请求。
 */
export function databaseProbe(db: Db): () => Promise<void> {
  return singleFlight(() => db.execute(sql`SELECT 1`).then(() => undefined));
}

export { schema };
