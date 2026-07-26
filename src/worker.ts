// 独立 worker 进程入口。
//
// 兑现架构里的承诺:worker 无本地状态 —— 认领靠 DB 乐观锁、事件走总线,
// 所以"拆成独立进程"只是换个启动方式,业务代码一行不改。
// 这个文件就是全部的"改动":复用同一个 composition root,只起 worker 不起 web。
//
// 部署时:web 侧设 OWA_EMBEDDED_WORKER=0,再按需起 N 个本进程实例。

import { getContainer } from "@/lib/container";

async function main(): Promise<void> {
  const { worker, env } = getContainer();

  console.log(
    `[owa-worker] 启动 pid=${process.pid} db=${env.databaseUrl.replace(/:\/\/[^@]*@/, "://***@")}`,
  );
  worker.start();

  let shuttingDown = false;
  /**
   * 优雅退出:先停止认领新任务,给在跑的任务留出时间。
   * 直接 kill 会让在跑的 run 变成孤儿 —— 虽然租约过期后能被回收,
   * 但那意味着白白等一个租约周期,还可能重复执行副作用。
   */
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[owa-worker] 收到 ${signal},停止认领新任务…`);
    worker.stop();
    // 给在跑的任务一点收尾时间;超时则强退,避免卡住部署
    setTimeout(() => {
      console.log("[owa-worker] 退出");
      process.exit(0);
    }, 5000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // 未捕获异常只记日志不退出 —— worker 循环自身有容错,单次失败不该拖垮整个进程
  process.on("unhandledRejection", (e) => {
    console.error("[owa-worker] 未处理的 Promise 拒绝:", e);
  });
}

void main();
