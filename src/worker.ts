// 独立 worker 进程入口。
//
// 兑现架构里的承诺:worker 无本地状态 —— 认领靠 DB 乐观锁、事件走总线,
// 所以"拆成独立进程"只是换个启动方式,业务代码一行不改。
// 这个文件就是全部的"改动":复用同一个 composition root,只起 worker 不起 web。
//
// 部署时:web 侧设 OWA_EMBEDDED_WORKER=0,再按需起 N 个本进程实例。

import { getContainer } from "@/lib/container";
// CJS 包,只有 default 导出 —— 具名 import 在 ESM 下会直接抛 SyntaxError
import nextEnv from "@next/env";

/**
 * 【必须先加载 .env】—— Next 会自动为 web 进程加载 .env / .env.local,
 * 而这个进程是裸 node,不会。
 *
 * 少了这一步的后果不是"起不来",而是**起得来但什么都干不成**:
 * 进程正常启动、日志打印正常、健康检查正常,可它认领到的每一个任务都以
 * `no key resolved from credential chain` 失败 —— 因为 OWA_ANTHROPIC_API_KEY
 * 只在 .env.local 里。
 *
 * 这个 bug 是这么漏掉的:我此前"验证"拆进程部署时,只确认了 worker 能启动,
 * 没让它真的跑完一个任务。"进程活着"和"进程在干活"是两件事。
 *
 * 必须在 import getContainer 之后、调用它之前执行 —— container 是惰性构建的,
 * loadEnv() 在第一次 getContainer() 时才读 process.env。
 */
nextEnv.loadEnvConfig(process.cwd(), false);

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
