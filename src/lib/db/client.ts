import { type MySql2Database, drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema";

export type Db = MySql2Database<typeof schema>;

/** 连接选项:连接池与单独建立的连接(见 bounded-result-reader)共用 */
export function connectionOptions(databaseUrl: string) {
  return {
    uri: databaseUrl,
    // 队列认领要比较 bigint 时间戳,按字符串取回会引入隐式转换
    supportBigNumbers: true,
    bigNumberStrings: false,
  };
}

/** 建连接池。调用方(container / 测试)负责生命周期。 */
export function createDb(databaseUrl: string): { db: Db; pool: mysql.Pool } {
  const pool = mysql.createPool({ ...connectionOptions(databaseUrl), connectionLimit: 10 });
  return { db: drizzle(pool, { schema, mode: "default" }), pool };
}

export { schema };
