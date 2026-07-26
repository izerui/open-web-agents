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

  /**
   * 关停宽限期。到点仍未排空就强退,避免卡住部署。
   * 默认 60 秒:比一个租约周期(60s)略长,常见的短任务能跑完;
   * 真正的长任务本来就不该指望在关停窗口里做完,交给栅栏与孤儿回收兜底。
   */
  const graceMs = Number(process.env.OWA_SHUTDOWN_GRACE_MS ?? 60_000);

  let shuttingDown = false;
  /**
   * 优雅退出:先停止认领新任务,再【真的等】在途任务收尾。
   *
   * 之前这里是 stop() 之后固定 setTimeout 5 秒就 process.exit(0),从不追踪在途
   * promise。而 maxDurationMs 默认 30 分钟 —— 也就是说几乎所有真实运行都会被
   * 中途砍掉,行留在 running 直到租约过期,再被别的 worker 从头重跑,
   * 正是上面那段注释声称要避免的「重复执行副作用」。
   * 注释描述的是意图,代码做的是相反的事。
   */
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[owa-worker] 收到 ${signal},停止认领新任务,最多等 ${graceMs}ms…`);
    worker.stop();
    void worker.drain(graceMs).then((clean) => {
      console.log(
        clean
          ? "[owa-worker] 在途任务已收尾,退出"
          : "[owa-worker] 宽限期到仍有任务在跑,强制退出 —— 它们会在租约过期后被其它 worker 接手",
      );
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // 未捕获异常只记日志不退出 —— worker 循环自身有容错,单次失败不该拖垮整个进程
  process.on("unhandledRejection", (e) => {
    console.error("[owa-worker] 未处理的 Promise 拒绝:", e);
  });
}

void main();
