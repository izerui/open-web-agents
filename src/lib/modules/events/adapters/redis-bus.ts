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

  /** 发布同样要超时:断连时命令无限排队,会把调用方拖住。 */
  async publish(topic: string, e: AgentEvent, timeoutMs = 2000): Promise<void> {
    await Promise.race([
      this.pub.publish(topic, JSON.stringify(e)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("redis publish timeout")), timeoutMs),
      ),
    ]);
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

  /**
   * 等订阅在服务端真正生效。
   *
   * 【必须带超时】ioredis 配了 maxRetriesPerRequest: null,断连时命令会【无限排队】
   * 而不是快速失败 —— 光 try/catch 抓不住,调用方会直接挂死。
   * 实测:Redis 停机后请求卡在这里直到客户端超时,任务连入队都没走到。
   * 超时后按"订阅没生效"处理,由调用方决定降级(通常是照常入队、放弃实时流)。
   */
  async ready(topic: string, timeoutMs = 2000): Promise<void> {
    await Promise.race([
      this.sub.subscribe(topic),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("redis subscribe timeout")), timeoutMs),
      ),
    ]);
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}
