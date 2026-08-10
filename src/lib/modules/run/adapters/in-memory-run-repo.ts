import type { NewRun, Run, RunRepo, RunStats } from "@/lib/modules/run/ports";
import type { RunState } from "@/lib/shared";

/** 内存队列 fake。application 层测试用,不碰真 IO。 */
export class InMemoryRunRepo implements RunRepo {
  private runs = new Map<string, Run>();
  /**
   * 创建时刻。Run 领域对象本身不带时间戳(队列只关心租约),
   * 但会话列表要按"最近活动"排序,所以 fake 也得记一份,与 MySQL 的 created_at 对齐。
   */
  private createdAt = new Map<string, number>();
  private fenceSeq = 0;

  async create(r: NewRun): Promise<Run> {
    const run: Run = { id: r.id, sessionId: r.sessionId, state: "pending", leaseUntil: null };
    this.runs.set(r.id, run);
    this.createdAt.set(r.id, Date.now());
    return run;
  }

  async claimNext(leaseMs: number, now: number): Promise<Run | null> {
    for (const run of this.runs.values()) {
      const claimable =
        run.state === "pending" ||
        (run.state === "running" && run.leaseUntil !== null && run.leaseUntil < now);
      if (claimable) {
        run.state = "running";
        run.leaseUntil = now + leaseMs;
        // 与 MySQL 实现同构:每次认领换新令牌,旧令牌立即作废
        run.fence = `fence-${++this.fenceSeq}`;
        return { ...run };
      }
    }
    return null;
  }

  async touch(id: string, leaseUntil: number, fence?: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || run.state !== "running") return false;
    if (fence && run.fence !== fence) return false;
    run.leaseUntil = leaseUntil;
    return true;
  }

  async complete(id: string, state: RunState, fence?: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || run.state !== "running") return false;
    if (fence && run.fence !== fence) return false;
    run.state = state;
    run.leaseUntil = null;
    run.fence = undefined;
    return true;
  }

  async cancel(id: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || (run.state !== "pending" && run.state !== "running")) return false;
    run.state = "cancelled";
    run.leaseUntil = null;
    // 令牌作废 —— 正在跑的 worker 下次续租会拿到 false,据此中止本轮
    run.fence = undefined;
    return true;
  }

  async reclaimOrphans(now: number): Promise<number> {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.state === "running" && run.leaseUntil !== null && run.leaseUntil < now) {
        run.state = "pending";
        run.leaseUntil = null;
        n++;
      }
    }
    return n;
  }

  async get(id: string): Promise<Run | null> {
    const run = this.runs.get(id);
    return run ? { ...run } : null;
  }

  async statsBySessions(sessionIds: string[]): Promise<Map<string, RunStats>> {
    const want = new Set(sessionIds);
    const out = new Map<string, RunStats>();
    if (want.size === 0) return out;

    for (const run of this.runs.values()) {
      if (!want.has(run.sessionId)) continue;
      const at = this.createdAt.get(run.id) ?? 0;
      const cur = out.get(run.sessionId);
      if (cur) {
        cur.runs += 1;
        if (at > cur.lastRunAt) cur.lastRunAt = at;
      } else {
        out.set(run.sessionId, { runs: 1, lastRunAt: at });
      }
    }
    return out;
  }
}
