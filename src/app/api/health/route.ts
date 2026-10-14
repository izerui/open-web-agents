import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getContainer } from "@/lib/container";
import { EnvModelGateway } from "@/lib/modules/model-gateway/adapters/env-gateway";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 探活单项的结果。耗时一并返回,便于发现"能连但很慢"这种半死状态。 */
interface Probe {
  ok: boolean;
  ms: number;
  error?: string;
}

/** 单项探活加超时 —— 依赖挂死时探活本身不能跟着挂死,否则编排系统也判不出来。 */
async function probe(fn: () => Promise<unknown>, timeoutMs = 2000): Promise<Probe> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return { ok: true, ms: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 健康检查。区分两个层次(容器编排需要不同语义):
 *
 * - liveness:进程还活着吗?活着就别重启我 —— 依赖挂了不等于进程该死,
 *   重启并不能修好数据库,反而会把正在跑的任务全打断。
 * - readiness:能接新流量吗?数据库不通就不该再往这个实例转发请求。
 *
 * `?probe=live` 只看进程;默认做完整就绪检查。
 */
/**
 * 沙箱开着时,确认内核隔离真的能起来。
 *
 * Linux 走 bubblewrap:直接跑一次最小隔离命令 —— 能起就是能起,不靠猜。
 * 其他平台不在生产范围,只如实标注不可验证。
 */
async function probeSandbox(): Promise<Record<string, unknown>> {
  if (process.platform !== "linux") {
    return { ok: true, note: `非 Linux(${process.platform}),生产以容器为准,此处不验证` };
  }
  const start = Date.now();
  try {
    await execFileAsync(
      "bwrap",
      ["--unshare-user", "--unshare-pid", "--dev", "/dev", "--ro-bind", "/", "/", "true"],
      { timeout: 3000 },
    );
    return { ok: true, ms: Date.now() - start, backend: "bubblewrap" };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - start,
      backend: "bubblewrap",
      // 这条信息直接决定运维该怎么做,不能只说"失败"
      hint: "bubblewrap 起不来→所有 agent 任务会硬失败。要么放开 user namespaces(推荐),要么显式设 OWA_SANDBOX=0",
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

export async function GET(req: Request) {
  let mode: string | null;
  try {
    mode = new URL(req.url).searchParams.get("probe");
  } catch {
    return Response.json({ error: "invalid request URL" }, { status: 400 });
  }

  // 存活探针必须极轻:不碰任何外部依赖
  if (mode === "live") {
    return Response.json({ status: "alive", uptimeSec: Math.round(process.uptime()) });
  }

  const { probeDatabase, bus, env, worker } = getContainer();

  const [database, redis] = await Promise.all([
    // 单一在途:这里超时只是不再等,底层那一次探测仍在,后来的探测共用它,不会在连接池里积压
    probe(() => probeDatabase()),
    probe(async () => {
      if (bus.ready) await bus.ready();
    }),
  ]);

  /**
   * worker 的健康【必须单独看】。
   *
   * 只探 SELECT 1 的话,worker 因为凭证错误或表缺失而每次轮询都抛异常、
   * 以 500ms 空转的时候,这个接口照样报 ready —— 队列在无声堆积,而运维毫不知情。
   * 连续失败到一定次数就判定它已经不干活了。
   */
  const w = worker.health();
  const workerOk = !w.running || w.consecutiveFailures < 5;

  /**
   * 沙箱可用性。
   *
   * 【为什么要单独抢】沙箱配了 failIfUnavailable: true —— bubblewrap 起不来就
   * 硬失败,没有“降级裸跑”这一档。而 bubblewrap 需要 user namespaces:
   * k8s / 受限 seccomp / 无特权 userns 的环境会禁用它。不在这里抢,
   * 就要等第一条真任务跑起来才发现 —— 而那时候已经在对外服务了。
   *
   * 【不计入 ready】沙箱不可用不影响接收流量(任务会失败但服务本身是活的),
   * 但必须在响应里如实暴露,让部署后一眼就能看到。
   */
  const sandbox = env.sandbox ? await probeSandbox() : { ok: true, skipped: "已显式关闭" };

  const ready = database.ok && redis.ok && workerOk;

  return Response.json(
    {
      status: ready ? "ready" : "degraded",
      uptimeSec: Math.round(process.uptime()),
      checks: {
        database,
        redis,
        // running=false 表示本进程没内嵌 worker(拆进程部署),不是故障
        worker: { ok: workerOk, ...w },
        sandbox,
      },
      // 运维排查时最想先确认的几项配置(不含任何密钥)
      config: {
        authRequired: env.authRequired,
        sandbox: env.sandbox,
        allowStdioMcp: env.allowStdioMcp,
        // 每个别名实际用哪个模型 —— 只看 OWA_MODEL 看不出单独配置的槽与官方默认
        models: new EnvModelGateway(env.models).slots(),
      },
    },
    // 未就绪返回 503,编排系统据此把流量摘走
    { status: ready ? 200 : 503 },
  );
}
