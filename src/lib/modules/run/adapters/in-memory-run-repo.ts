import type { NewRun, Run, RunRepo } from "@/lib/modules/run/ports";
import type { RunState } from "@/lib/shared";

/** 内存队列 fake。application 层测试用,不碰真 IO。 */
export class InMemoryRunRepo implements RunRepo {
  private runs = new Map<string, Run>();

  async create(r: NewRun): Promise<Run> {
    const run: Run = { id: r.id, sessionId: r.sessionId, state: "pending", leaseUntil: null };
    this.runs.set(r.id, run);
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
        return { ...run };
      }
    }
    return null;
  }

  async touch(id: string, leaseUntil: number): Promise<void> {
    const run = this.runs.get(id);
    if (run) run.leaseUntil = leaseUntil;
  }

  async complete(id: string, state: RunState): Promise<void> {
    const run = this.runs.get(id);
    if (run) {
      run.state = state;
      run.leaseUntil = null;
    }
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
}
