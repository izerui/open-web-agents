// SteerChannel 的内存实现:单进程、单测用。语义与 Redis 实现一致(同一套契约测试)。

import type { SteerChannel } from "@/lib/modules/run/ports";

type Msg = { id: string; text: string };

export class InMemorySteerChannel implements SteerChannel {
  private readonly state = new Map<string, "open" | "closed">();
  private readonly queue = new Map<string, Msg[]>();
  private readonly outcomes = new Map<string, "delivered" | "dropped">();
  private readonly listeners = new Map<string, Set<() => void>>();

  async offer(runId: string, m: Msg): Promise<"accepted" | "closed"> {
    if (this.state.get(runId) !== "open") return "closed";
    this.queue.set(runId, [...(this.queue.get(runId) ?? []), m]);
    for (const cb of this.listeners.get(runId) ?? []) cb();
    return "accepted";
  }

  async awaitOutcome(
    runId: string,
    id: string,
    timeoutMs: number,
  ): Promise<"delivered" | "dropped" | "pending"> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const o = this.outcomes.get(`${runId}:${id}`);
      if (o) return o;
      if (Date.now() >= deadline) return "pending";
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async open(runId: string): Promise<void> {
    this.state.set(runId, "open");
  }

  async take(runId: string): Promise<Msg[]> {
    const q = this.queue.get(runId) ?? [];
    this.queue.delete(runId);
    return q;
  }

  async close(runId: string): Promise<Msg[]> {
    this.state.set(runId, "closed");
    return this.take(runId);
  }

  async settle(runId: string, id: string, outcome: "delivered" | "dropped"): Promise<void> {
    this.outcomes.set(`${runId}:${id}`, outcome);
  }

  onOffer(runId: string, cb: () => void): () => void {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(cb);
    this.listeners.set(runId, set);
    return () => set.delete(cb);
  }
}
