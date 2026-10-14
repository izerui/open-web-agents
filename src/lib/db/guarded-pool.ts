// 受保护的连接池:数据库卡死(网络断了而 TCP 没断开)时,卡住的连接会被真正断开,连接池自己恢复。
//
// mysql2 的连接池本身管不了这件事(实测,mysql2 3.23):
// - 没有查询总超时;自带的单条查询超时只是先给调用方一个错误,命令仍挂在连接上,连接不归还。
// - connectTimeout 在收到第一段数据(服务器问候)时就被清掉;问候之后认证卡住,永远不超时,
//   而连接池在握手完成前不交出连接,调用方手里没有可以断开的句柄。
// - destroy() 只是 close(),close() 只发 FIN(stream.end()),而且把这次关闭当成主动的 ——
//   挂起的命令永远收不到错误。
// 实测有效的做法是【直接销毁底层套接字】(不经 close):挂起的命令立刻以"连接丢失"报错,
// 连接移出连接池;握手中销毁,获取连接的一方报错,名额释放。
//
// 两道保护:
// 1. 握手期限:连接池通过 stream 选项用我们建的套接字,从建连起计时,握手完成(连接池发出
//    connection 事件)才解除;到期销毁套接字。
// 2. 命令期限:只在一条 query / execute 【正在执行】时计时,到期销毁这条连接的套接字。
//    【不按借出时长计】—— 事务里会做文件操作(工作目录的改名与清理在行锁内完成),
//    那段时间没有命令在执行,断开连接会释放行锁却取消不了已经发出的改名,
//    新运行拿到锁后可能被迟到的改名把目录搬走。所以事务里的空档一概不计。
//    等行锁也算"命令在执行"(客户端分不清它与网络卡死),所以期限要长于 MySQL 的等锁上限(见 client.ts)。
//
// 为什么不换现成驱动(实测,mariadb 3.5.4):它的 connectTimeout 覆盖整个握手、socketTimeout 会真正销毁套接字,
// 但 socketTimeout 按"一段时间没有数据"计 —— 事务里的文件操作空档同样会被断开;queryTimeout 只支持 MariaDB 服务器;
// drizzle 的 MySQL 驱动也只支持 mysql2。

import net from "node:net";
import type mysql from "mysql2/promise";

/** 单条命令超过期限:它所在的连接已被断开 */
export class DbCommandTimeout extends Error {
  constructor(ms: number, cause: unknown) {
    super(`数据库命令超过 ${ms}ms 未完成,已断开该连接`, { cause });
    this.name = "DbCommandTimeout";
  }
}

type PromiseConn = mysql.PoolConnection;

/**
 * 连接的底层套接字。promise 版连接(PromisePoolConnection)在 .connection 上挂着底层连接;
 * 连接池事件(connection / acquire)原样转发的是底层连接本身,套接字直接在 .stream 上。两种都认。
 */
function socketOf(conn: unknown): net.Socket | undefined {
  const c = conn as { stream?: net.Socket; connection?: { stream?: net.Socket } } | undefined;
  return c?.stream ?? c?.connection?.stream;
}

/**
 * 给连接池配置加上握手期限:返回要并入 createPool 配置的 stream 选项,以及挂到连接池上的收尾。
 * 必须在 createPool 时传入 —— 套接字由这里建,握手期间才有句柄。
 */
export function handshakeGuard(handshakeMs: number) {
  const timers = new WeakMap<net.Socket, ReturnType<typeof setTimeout>>();
  const stream = (opts: { config: { host?: string; port?: number; socketPath?: string } }) => {
    const { host, port, socketPath } = opts.config;
    const socket = socketPath ? net.connect(socketPath) : net.connect(port ?? 3306, host);
    // 空闲连接的对端若已不在,早些发现(原本由驱动的 enableKeepAlive 做,自己建套接字后要自己开)
    socket.once("connect", () => socket.setKeepAlive(true, 10_000));
    timers.set(
      socket,
      setTimeout(() => socket.destroy(), handshakeMs),
    );
    socket.once("close", () => clearTimeout(timers.get(socket)));
    return socket;
  };
  /**
   * 握手完成:解除这条连接的握手计时。
   * 【这个监听器绝不能抛】mysql2 在交出连接(getConnection 的回调)之前同步触发 connection 事件,
   * 这里一抛,回调就不会再被调用 —— 所有获取连接的一方都会永远等下去。
   */
  const attach = (pool: mysql.Pool) => {
    pool.on("connection", (conn) => {
      try {
        const socket = socketOf(conn);
        if (socket) clearTimeout(timers.get(socket));
      } catch {
        // 取不到套接字也只是少解除一个计时:握手早已完成,到期销毁的是一条健康连接 —— 宁可如此也不能卡死
      }
    });
  };
  return { stream, attach };
}

/**
 * 在一条命令执行期间计时,到期直接销毁这条连接的套接字:挂起的命令随之以"连接丢失"报错,
 * 再包成 DbCommandTimeout 抛出。万一驱动没有让它报错,最多再等 closeWaitMs 也抛出,不会因此挂住。
 */
async function runGuarded<T>(
  conn: PromiseConn,
  commandMs: number,
  run: () => Promise<T>,
  closeWaitMs = 1_000,
): Promise<T> {
  let killed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const pending = run();
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      killed = true;
      socketOf(conn)?.destroy();
      giveUp = setTimeout(
        () => reject(new DbCommandTimeout(commandMs, new Error("连接断开后命令仍未结束"))),
        closeWaitMs,
      );
    }, commandMs);
  });
  try {
    return await Promise.race([pending, expired]);
  } catch (err) {
    if (killed && !(err instanceof DbCommandTimeout)) throw new DbCommandTimeout(commandMs, err);
    throw err;
  } finally {
    clearTimeout(timer);
    clearTimeout(giveUp);
    pending.catch(() => {});
  }
}

/** 借出的连接:query / execute 受命令期限保护,其余原样 */
function guardConnection(conn: PromiseConn, commandMs: number): PromiseConn {
  return new Proxy(conn, {
    get(target, key) {
      if (key === "query" || key === "execute") {
        const method = target[key] as (...a: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) =>
          runGuarded(target, commandMs, () => method.apply(target, args));
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * 交给 drizzle 的连接池:query / execute 自己借连接、受命令期限保护再归还;
 * 事务经 getConnection 拿到的连接同样受保护。drizzle 只用到这几个方法(drizzle-orm/mysql2/session)。
 */
export class GuardedPool {
  constructor(
    readonly raw: mysql.Pool,
    private readonly commandMs: number | null,
  ) {}

  /** 同一个底层连接池、不同命令期限的视图(如健康检查用更短的期限) */
  withCommandTimeout(ms: number | null): GuardedPool {
    return new GuardedPool(this.raw, ms);
  }

  async getConnection(): Promise<PromiseConn> {
    const conn = await this.raw.getConnection();
    return this.commandMs === null ? conn : guardConnection(conn, this.commandMs);
  }

  query(...args: unknown[]): Promise<unknown> {
    return this.withConnection((c) => (c.query as (...a: unknown[]) => Promise<unknown>)(...args));
  }

  execute(...args: unknown[]): Promise<unknown> {
    return this.withConnection((c) =>
      (c.execute as (...a: unknown[]) => Promise<unknown>)(...args),
    );
  }

  end(): Promise<void> {
    return this.raw.end();
  }

  private async withConnection<T>(fn: (c: PromiseConn) => Promise<T>): Promise<T> {
    const conn = await this.getConnection();
    try {
      return await fn(conn);
    } finally {
      // 被断开的连接也交回:连接池认得出已失效的连接并移出(实测单连接池随后照常可用)
      conn.release();
    }
  }
}
