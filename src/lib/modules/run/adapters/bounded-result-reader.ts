// 有时限的运行结果读取 —— 终态兜底(watchTerminal)与阻塞模式补读用。
//
// 【为什么不能只是"超时就不等了"】数据库连接卡死(网络断了而 TCP 没断开)时,查询既不返回也不报错。
// 只在上层放弃等待,底层命令仍挂在那条连接上;连接被放回池里后,后面排到它的查询一起卡死 ——
// 实测单连接的池里,放弃等待的那条连接解冻后也再拿不到。mysql2 自带的查询超时也一样:
// 它只是先给调用方一个错误,命令并没有结束,连接也不归还。
// 所以到期就【断开那条连接】:套接字关闭,这次读取用到的连接才算真正结束。
// mysql2 断开连接时不会通知挂起的命令 —— 那条查询的 Promise 永远不会结束,不能拿它当信号,以套接字关闭为准。
//
// 【为什么不用 mysql2 的连接池】建连同样可能卡住,而连接池在握手完成之前不会把连接交出来,
// 调用方手里没有可以断开的句柄;驱动的 connectTimeout 又在收到第一段数据(服务器问候)时就清掉了
// (lib/base/connection.js),问候之后认证卡住就既拿不到连接、也永远不超时。所以这里自己管连接:
// 底层 createConnection 同步返回连接对象,握手期间也能断开。
//
// 一次读取从入口起只有一个总期限,覆盖排队、建连握手、查询三段;到期时正在握手或查询的连接被断开,
// 排队中的直接退出(手里没有连接)。所有连接都受这个期限约束,所以排队也有上限。
//
// 独立于主连接池:兜底读取本来就是"别处出了问题时仍能从库里拿到结果",
// 不该因为主池被别的卡住的查询占满而跟着排队。

import type { Socket } from "node:net";
import { type Db, connectionOptions, schema } from "@/lib/db/client";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import type { RunRecord } from "@/lib/modules/run/domain/run-result";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2";

/** 一次读取超过期限:用到的连接已断开 */
export class ResultReadTimeout extends Error {
  constructor(runId: string, ms: number) {
    super(`读取运行结果超过 ${ms}ms 未完成,已断开所用的数据库连接(run=${runId})`);
    this.name = "ResultReadTimeout";
  }
}

export interface BoundedResultReaderOptions {
  databaseUrl: string;
  /** 同时存在的连接上限(含握手中的) */
  maxConnections?: number;
  /** 一次读取的总期限:排队 + 建连握手 + 查询 */
  timeoutMs?: number;
  /** 断开连接后等套接字关闭的上限 —— 不能因为等关闭而又挂住 */
  closeWaitMs?: number;
}

type Conn = mysql.Connection;

const socketOf = (c: Conn) => (c as unknown as { stream?: Socket }).stream;

export class BoundedResultReader {
  private readonly maxConnections: number;
  private readonly timeoutMs: number;
  private readonly closeWaitMs: number;
  /** 已建立、空闲可用的连接 */
  private readonly idle: Conn[] = [];
  /** 现存的全部连接(握手中 + 使用中 + 空闲) */
  private total = 0;
  /** 等连接名额的读取:有连接归还或名额空出时按序唤醒 */
  private readonly waiters: (() => void)[] = [];
  private closed = false;
  /** 已作废(不再计数)的连接 —— 同一条可能先后经 end 事件与 discard 两条路径到这里 */
  private readonly gone = new WeakSet<Conn>();

  constructor(private readonly opts: BoundedResultReaderOptions) {
    this.maxConnections = opts.maxConnections ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 2_000;
    this.closeWaitMs = opts.closeWaitMs ?? 1_000;
  }

  /**
   * 读一条运行的结果。返回或拒绝时,这次读取用到的连接都已没有在途操作:
   * 正常完成就留作空闲;出错或到期就断开(到期抛 ResultReadTimeout)。
   */
  async getResult(runId: string): Promise<RunRecord | null> {
    const deadline = Date.now() + this.timeoutMs;
    const conn = await this.acquire(runId, deadline);
    const query = new MysqlRunRepo(
      drizzle(conn.promise(), { schema, mode: "default" }) as unknown as Db,
    ).getResult(runId);
    let outcome: { row: RunRecord | null } | "timeout";
    try {
      outcome = await raceDeadline(
        query.then((row) => ({ row })),
        deadline,
      );
    } catch (err) {
      // 查询报错:连接状态不可信,不再复用
      await this.discard(conn);
      throw err;
    }
    if (outcome === "timeout") {
      // 断开后这条查询的 Promise 不会再结束;挂一个空处理,免得日后某种路径拒绝时成为未处理的拒绝
      query.catch(() => {});
      await this.discard(conn);
      throw new ResultReadTimeout(runId, this.timeoutMs);
    }
    this.release(conn);
    return outcome.row;
  }

  /** 关闭全部连接(测试与进程退出用) */
  async end(): Promise<void> {
    this.closed = true;
    const all = this.idle.splice(0);
    await Promise.all(all.map((c) => this.discard(c)));
  }

  private async acquire(runId: string, deadline: number): Promise<Conn> {
    for (;;) {
      if (this.closed) throw new Error("结果读取源已关闭");
      const free = this.idle.pop();
      if (free) return free;
      if (this.total < this.maxConnections) return this.connect(runId, deadline);
      // 名额已满:排队等,到期就退出(手里没有连接,无需断开)。
      // 占用者都受期限约束、到期必断开并唤醒排队者;这里的期限防的是被唤醒后名额又被新来的读取抢走、
      // 反复重新排队的情况(测试里没法确定地造出这种交错,未单独验证)
      let wake!: () => void;
      const woken = new Promise<void>((resolve) => {
        wake = resolve;
      });
      this.waiters.push(wake);
      const r = await raceDeadline(woken, deadline);
      if (r === "timeout") {
        const i = this.waiters.indexOf(wake);
        if (i >= 0) this.waiters.splice(i, 1);
        throw new ResultReadTimeout(runId, this.timeoutMs);
      }
    }
  }

  /** 建连并完成握手;到期就断开这条半开的连接 */
  private async connect(runId: string, deadline: number): Promise<Conn> {
    this.total++;
    const conn = mysql.createConnection(connectionOptions(this.opts.databaseUrl));
    const ready = new Promise<"ready">((resolve, reject) => {
      conn.once("connect", () => resolve("ready"));
      conn.once("error", reject);
    });
    // 握手之后的 error / end(服务器断开、网络错误)都只意味着这条连接作废
    conn.on("error", () => {});
    let r: "ready" | "timeout";
    try {
      r = await raceDeadline(ready, deadline);
    } catch (err) {
      await this.discard(conn);
      throw err;
    }
    if (r === "timeout") {
      ready.catch(() => {});
      await this.discard(conn);
      throw new ResultReadTimeout(runId, this.timeoutMs);
    }
    // 空闲时被服务器关掉的连接不能再分出去
    conn.once("end", () => void this.forget(conn));
    return conn;
  }

  private release(conn: Conn) {
    if (this.closed) {
      void this.discard(conn);
      return;
    }
    this.idle.push(conn);
    this.waiters.shift()?.();
  }

  /** 作废一条连接:移出空闲列表、不再计数(重复调用无效) */
  private forget(conn: Conn) {
    const i = this.idle.indexOf(conn);
    if (i >= 0) this.idle.splice(i, 1);
    if (this.gone.has(conn)) return;
    this.gone.add(conn);
    this.total--;
    // 名额空出:唤醒一个排队的读取去新建连接
    this.waiters.shift()?.();
  }

  /** 断开连接并等套接字关闭 */
  private async discard(conn: Conn) {
    this.forget(conn);
    const socket = socketOf(conn);
    const closed =
      socket && !socket.closed
        ? new Promise<void>((resolve) => socket.once("close", () => resolve()))
        : Promise.resolve();
    conn.destroy();
    await raceDeadline(closed, Date.now() + this.closeWaitMs);
  }
}

/** 等 p 或到期(返回 "timeout");p 的拒绝原样抛出 */
async function raceDeadline<T>(p: Promise<T>, deadline: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
