// SteerChannel 的内存实现:单进程、单测用。语义与 Redis 实现一致(同一套契约测试)。

import type { SteerChannel, SteerOfferResult } from "@/lib/modules/run/ports";

type Msg = { id: string; text: string };

export class InMemorySteerChannel implements SteerChannel {
  private readonly state = new Map<string, "open" | "closed">();
  /** 还没有结局的消息,按受理顺序 */
  private readonly pending = new Map<string, Msg[]>();
  private readonly outcomes = new Map<string, "rejected" | "delivered" | "dropped">();
  private readonly listeners = new Map<string, Set<() => void>>();

  async offer(runId: string, m: Msg): Promise<SteerOfferResult> {
    const done = this.outcomes.get(`${runId}:${m.id}`);
    if (done) return done;
    const q = this.pending.get(runId) ?? [];
    if (q.some((x) => x.id === m.id)) return "accepted";
    if (this.state.get(runId) !== "open") {
      this.outcomes.set(`${runId}:${m.id}`, "rejected");
      return "rejected";
    }
    this.pending.set(runId, [...q, m]);
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
      if (o === "delivered" || o === "dropped") return o;
      if (Date.now() >= deadline) return "pending";
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async open(runId: string): Promise<void> {
    this.state.set(runId, "open");
  }

  async take(runId: string): Promise<Msg[]> {
    return [...(this.pending.get(runId) ?? [])];
  }

  async close(runId: string): Promise<Msg[]> {
    this.state.set(runId, "closed");
    return this.take(runId);
  }

  async settle(runId: string, id: string, outcome: "delivered" | "dropped"): Promise<void> {
    this.outcomes.set(`${runId}:${id}`, outcome);
    this.pending.set(
      runId,
      (this.pending.get(runId) ?? []).filter((m) => m.id !== id),
    );
  }

  onOffer(runId: string, cb: () => void): () => void {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(cb);
    this.listeners.set(runId, set);
    return () => set.delete(cb);
  }
}
