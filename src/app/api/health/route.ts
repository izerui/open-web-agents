import { getContainer } from "@/lib/container";
import { sql } from "drizzle-orm";

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
export async function GET(req: Request) {
  const mode = new URL(req.url).searchParams.get("probe");

  // 存活探针必须极轻:不碰任何外部依赖
  if (mode === "live") {
    return Response.json({ status: "alive", uptimeSec: Math.round(process.uptime()) });
  }

  const { db, bus, env } = getContainer();

  const [database, redis] = await Promise.all([
    probe(() => db.execute(sql`SELECT 1`)),
    // 发一条到无人订阅的探测频道 —— 只验证连通性,不产生副作用
    probe(() => bus.publish("owa:health", { kind: "status", label: "probe" })),
  ]);

  const ready = database.ok && redis.ok;

  return Response.json(
    {
      status: ready ? "ready" : "degraded",
      uptimeSec: Math.round(process.uptime()),
      checks: { database, redis },
      // 运维排查时最想先确认的几项配置(不含任何密钥)
      config: {
        authRequired: env.authRequired,
        sandbox: env.sandbox,
        model: env.models.base,
      },
    },
    // 未就绪返回 503,编排系统据此把流量摘走
    { status: ready ? 200 : 503 },
  );
}
