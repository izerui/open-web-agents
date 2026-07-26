import type { BusPort, Unsubscribe } from "@/lib/modules/events/ports";
import type { AgentEvent } from "@/lib/shared";

/** 单进程内存总线。MVP 与测试用;多进程部署须换 Redis pub/sub(否则订阅静默失效)。 */
export class InMemoryBus implements BusPort {
  private subs = new Map<string, Set<(e: AgentEvent) => void>>();

  async publish(topic: string, e: AgentEvent): Promise<void> {
    // 迭代快照:回调里退订不会打乱本次派发
    for (const cb of [...(this.subs.get(topic) ?? [])]) cb(e);
  }

  subscribe(topic: string, cb: (e: AgentEvent) => void): Unsubscribe {
    const set = this.subs.get(topic) ?? new Set();
    set.add(cb);
    this.subs.set(topic, set);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.subs.delete(topic);
    };
  }
}
