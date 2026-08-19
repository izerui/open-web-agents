import type { BusPort, StreamSubscriptionOptions, Unsubscribe } from "@/lib/modules/events/ports";
import type { AgentEvent } from "@/lib/shared";

interface StoredEvent {
  id: string;
  event: AgentEvent;
}

/** 单进程内存事件流。测试用;生产多实例使用 Redis Streams。 */
export class InMemoryBus implements BusPort {
  private subs = new Map<string, Set<(e: AgentEvent, id: string) => void>>();
  private events = new Map<string, StoredEvent[]>();
  private sequence = 0;

  async publish(topic: string, e: AgentEvent): Promise<string> {
    const id = `${Date.now()}-${++this.sequence}`;
    const stored = this.events.get(topic) ?? [];
    stored.push({ id, event: e });
    this.events.set(topic, stored);
    for (const cb of [...(this.subs.get(topic) ?? [])]) {
      queueMicrotask(() => {
        if (this.subs.get(topic)?.has(cb)) cb(e, id);
      });
    }
    return id;
  }

  subscribe(
    topic: string,
    cb: (e: AgentEvent, id: string) => void,
    options: StreamSubscriptionOptions = {},
  ): Unsubscribe {
    const set = this.subs.get(topic) ?? new Set();
    set.add(cb);
    this.subs.set(topic, set);

    if (options.afterId !== undefined) {
      for (const item of this.events.get(topic) ?? []) {
        if (compareIds(item.id, options.afterId) > 0) {
          queueMicrotask(() => {
            if (this.subs.get(topic)?.has(cb)) cb(item.event, item.id);
          });
        }
      }
    }

    return () => {
      set.delete(cb);
      if (set.size === 0) this.subs.delete(topic);
    };
  }
}

function compareIds(a: string, b: string): number {
  const [aMs = 0, aSeq = 0] = a.split("-").map(Number);
  const [bMs = 0, bSeq = 0] = b.split("-").map(Number);
  return aMs - bMs || aSeq - bSeq;
}
