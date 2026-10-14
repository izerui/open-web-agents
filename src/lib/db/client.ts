import { type MySql2Database, drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { GuardedPool, handshakeGuard } from "./guarded-pool";
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

export interface CreateDbOptions {
  connectionLimit?: number;
  /** 建连握手的期限(含问候之后的认证),默认 10 秒 */
  handshakeMs?: number;
  /**
   * 单条命令执行中的期限,默认 60 秒;null = 不限(迁移的 DDL 可能很久)。
   * 【要长于 MySQL 的等锁上限】等行锁(FOR UPDATE)期间命令同样"在执行",客户端分不清它与网络卡死;
   * 服务器自己会在 innodb_lock_wait_timeout(默认 50 秒)到点报错。期限比它长,正常的等锁仍由
   * MySQL 按原样报错,只有连错误都送不过来的真卡死才由这里断开。
   */
  commandMs?: number | null;
}

/**
 * 建连接池。调用方(container / 测试)负责生命周期。
 * 数据库卡死时,卡住的握手与执行中的命令到期会被断开、连接池自己恢复(见 guarded-pool.ts)。
 */
export function createDb(
  databaseUrl: string,
  opts: CreateDbOptions = {},
): { db: Db; pool: GuardedPool } {
  const handshake = handshakeGuard(opts.handshakeMs ?? 10_000);
  const raw = mysql.createPool({
    ...connectionOptions(databaseUrl),
    connectionLimit: opts.connectionLimit ?? 10,
    stream: handshake.stream,
  } as mysql.PoolOptions);
  handshake.attach(raw);
  const pool = new GuardedPool(raw, opts.commandMs === undefined ? 60_000 : opts.commandMs);
  return { db: dbOver(pool), pool };
}

/** 同一个受保护连接池上的 drizzle 实例(如健康检查用更短命令期限的视图) */
export function dbOver(pool: GuardedPool): Db {
  // drizzle 只用到连接池的 query / execute / getConnection(见 guarded-pool.ts)
  return drizzle(pool as unknown as mysql.Pool, { schema, mode: "default" });
}

export { schema };
