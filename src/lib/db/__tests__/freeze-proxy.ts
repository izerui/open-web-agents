// 测试用的可"冻结" TCP 代理与客户端套接字追踪 —— 模拟数据库卡死(网络不通而 TCP 没断开)。
//
// - frozen:两个方向都不转发,连接保持打开。
// - stallAuth:此后新建的连接只放过服务器的第一段数据(握手问候),之后两向都丢 ——
//   停在"问候之后、认证完成之前";服务器自己的超时报错与关闭也传不到客户端,和真实断网一样。
// - ignoreFin:收到客户端 FIN(半关闭)后不回应、不关闭(allowHalfOpen)。

import net from "node:net";
import { vi } from "vitest";

export async function startFreezeProxy(target: URL) {
  const state = {
    frozen: false,
    stallAuth: false,
    ignoreFin: false,
    open: 0,
    peak: 0,
    /** 送达客户端的服务器字节数 */
    serverBytes: 0,
  };
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect(Number(target.port || 3306), target.hostname);
    sockets.add(client);
    state.open++;
    state.peak = Math.max(state.peak, state.open);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      state.open--;
      sockets.delete(client);
      client.destroy();
      upstream.destroy();
    };
    const stalled = state.stallAuth;
    let greeted = false;
    client.on("data", (d) => {
      if (!state.frozen && !stalled) upstream.write(d);
    });
    upstream.on("data", (d) => {
      if (state.frozen || (stalled && greeted)) return;
      greeted = true;
      state.serverBytes += d.length;
      client.write(d);
    });
    client.on("close", close);
    client.on("error", close);
    client.on("end", () => {
      if (!state.ignoreFin) close();
    });
    const upstreamGone = () => {
      if (!(stalled || state.frozen)) close();
    };
    upstream.on("close", upstreamGone);
    upstream.on("error", upstreamGone);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  const url = new URL(target.toString());
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return {
    url: url.toString(),
    port,
    state,
    /** 恢复正常转发 */
    heal() {
      state.frozen = false;
      state.stallAuth = false;
      state.ignoreFin = false;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/**
 * 记下连到 port 的每条客户端套接字 —— 从代理那头看,客户端 end() 与 destroy() 都只是一个 FIN,
 * 要验证"旧套接字真的关闭了"得看客户端这一侧。用完 vi.restoreAllMocks() 还原。
 */
export function trackClientSockets(port: number) {
  const sockets: net.Socket[] = [];
  const realConnect = net.connect;
  vi.spyOn(net, "connect").mockImplementation(((...args: Parameters<typeof net.connect>) => {
    const socket = (realConnect as (...a: unknown[]) => net.Socket)(...args);
    const opts = args[0] as { port?: number } | number;
    if ((typeof opts === "number" ? opts : opts?.port) === port) sockets.push(socket);
    return socket;
  }) as typeof net.connect);
  return {
    sockets,
    alive: () => sockets.filter((s) => !s.closed).length,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
