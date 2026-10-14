// 有时限的运行结果读取 —— 终态兜底(watchTerminal)与阻塞模式补读用。
//
// 【为什么不能只是"超时就不等了"】数据库连接卡死(网络断了而 TCP 没断开)时,查询既不返回也不报错。
// 只在上层放弃等待,底层命令仍挂在那条连接上;连接被放回池里后,后面排到它的查询一起卡死 ——
// 实测单连接的池里,放弃等待的那条连接解冻后也再拿不到。mysql2 自带的查询超时也一样:
// 它只是先给调用方一个错误,命令并没有结束,连接也不归还。
//
// 所以超时就【销毁这条连接】:套接字关闭,连接移出连接池,底层这次查询才算真正结束。
// 注意 mysql2 销毁连接时不会通知挂起的命令 —— 那条查询的 Promise 永远不会结束,
// 不能拿它当"结束"的信号;以套接字关闭为准。
//
// 用独立的小连接池:兜底读取本来就是"别处出了问题时仍能从库里拿到结果",
// 不该因为主池被别的卡住的查询占满而跟着排队。这里的每条连接都受时限保护,排队有上限;
// 建连由连接池的 connectTimeout 限时(见 container),所以一次读取的总等待也有上限。

import type { Socket } from "node:net";
import { type Db, schema } from "@/lib/db/client";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import type { RunRecord } from "@/lib/modules/run/domain/run-result";
import { drizzle } from "drizzle-orm/mysql2";
import type mysql from "mysql2/promise";

/** 一次读取超过时限:连接已销毁,底层查询已结束 */
export class ResultReadTimeout extends Error {
  constructor(runId: string, ms: number) {
    super(`读取运行结果超过 ${ms}ms 未返回,已断开该数据库连接(run=${runId})`);
    this.name = "ResultReadTimeout";
  }
}

/** 销毁连接后等套接字确认关闭(最多再等 closeWaitMs,不能因为等关闭而又挂住) */
async function destroyAndWaitClosed(conn: mysql.PoolConnection, closeWaitMs: number) {
  const socket = (conn.connection as unknown as { stream?: Socket }).stream;
  const closed =
    socket && !socket.closed
      ? new Promise<void>((resolve) => socket.once("close", () => resolve()))
      : Promise.resolve();
  conn.destroy();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    closed,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, closeWaitMs);
    }),
  ]);
  clearTimeout(timer);
}

export class BoundedResultReader {
  constructor(
    private readonly pool: mysql.Pool,
    private readonly timeoutMs = 2_000,
    private readonly closeWaitMs = 1_000,
  ) {}

  /**
   * 读一条运行的结果。返回或拒绝时,这次读取用到的连接都已经没有在途的命令:
   * 正常完成就归还连接;超时就销毁连接并抛 ResultReadTimeout。
   */
  async getResult(runId: string): Promise<RunRecord | null> {
    const conn = await this.pool.getConnection();
    const query = new MysqlRunRepo(drizzle(conn, { schema, mode: "default" }) as Db).getResult(
      runId,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
    });
    let outcome: { row: RunRecord | null } | "timeout";
    try {
      outcome = await Promise.race([query.then((row) => ({ row })), expired]);
    } catch (err) {
      // 查询本身报错:命令已结束,连接交回连接池(致命错误的连接由驱动自行废弃)
      clearTimeout(timer);
      conn.release();
      throw err;
    }
    clearTimeout(timer);
    if (outcome !== "timeout") {
      conn.release();
      return outcome.row;
    }
    // 销毁后这条查询的 Promise 不会再结束;挂一个空处理,免得日后某种路径拒绝时成为未处理的拒绝
    query.catch(() => {});
    await destroyAndWaitClosed(conn, this.closeWaitMs);
    throw new ResultReadTimeout(runId, this.timeoutMs);
  }
}
