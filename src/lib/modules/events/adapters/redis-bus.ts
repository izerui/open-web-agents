// Redis pub/sub 事件总线。
//
// 为什么必须是它:单进程 EventEmitter 在多 worker / 多实例下会静默失效 ——
// 事件发生在 worker 进程,SSE 连接却挂在另一个 web 进程上,订阅者永远收不到。
// (设计文档 §13.2 把这条列为红线。)
//
// ioredis 的订阅连接进入 subscriber 模式后不能再发普通命令,故 pub/sub 各持一条连接。

import type { BusPort, Unsubscribe } from "@/lib/modules/events/ports";
import type { AgentEvent } from "@/lib/shared";
import Redis from "ioredis";

export class RedisBus implements BusPort {
  private readonly pub: Redis;
  private readonly sub: Redis;
  /** 本进程内的订阅者:topic → 回调集合。 */
  private readonly handlers = new Map<string, Set<(e: AgentEvent) => void>>();

  constructor(redisUrl: string) {
    this.pub = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.sub = new Redis(redisUrl, { maxRetriesPerRequest: null });

    this.sub.on("message", (channel, payload) => {
      const set = this.handlers.get(channel);
      if (!set?.size) return;
      let event: AgentEvent;
      try {
        event = JSON.parse(payload) as AgentEvent;
      } catch {
        return; // 非本系统写入的脏数据,忽略
      }
      // 快照迭代:回调里退订不打乱本次派发
      for (const cb of [...set]) cb(event);
    });
  }

  async publish(topic: string, e: AgentEvent): Promise<void> {
    await this.pub.publish(topic, JSON.stringify(e));
  }

  subscribe(topic: string, cb: (e: AgentEvent) => void): Unsubscribe {
    const set = this.handlers.get(topic) ?? new Set();
    const isFirst = set.size === 0;
    set.add(cb);
    this.handlers.set(topic, set);

    // 首个订阅者才向 Redis 注册频道
    if (isFirst) void this.sub.subscribe(topic).catch(() => {});

    return () => {
      set.delete(cb);
      if (set.size === 0) {
        this.handlers.delete(topic);
        void this.sub.unsubscribe(topic).catch(() => {});
      }
    };
  }

  /** 订阅是异步注册的;需要"订阅已生效"再发布时用它等待。 */
  async ready(topic: string): Promise<void> {
    await this.sub.subscribe(topic);
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}
