// 双缓冲重放:支撑断线重连(joinStream)。
//
// Redis pub/sub 不持久 —— 刷新页面重新订阅时,之前发过的事件全都错过了。
// 故在总线之外保留一份按会话的近期事件:
// - state 类(status/artifact/usage/result)全留 —— 少一条,前端就重建不出当前状态
// - noise 类(text/thinking/tool_*)滚动淘汰 —— 只保最近若干条,避免无界增长
//
// 单进程内存实现;多实例部署需换成 Redis List(端口不变)。

import { isStateEvent } from "@/lib/shared";
import type { AgentEvent } from "@/lib/shared";

/** noise 类事件的保留条数。够重建"正在干什么"的观感,又不至于吃内存。 */
const NOISE_LIMIT = 200;

interface Buffered {
  state: AgentEvent[];
  noise: AgentEvent[];
  /** 是否已收到终态 result —— 重连时据此决定要不要继续挂流。 */
  done: boolean;
  updatedAt: number;
}

export class ReplayBuffer {
  private topics = new Map<string, Buffered>();

  constructor(private readonly noiseLimit = NOISE_LIMIT) {}

  record(topic: string, e: AgentEvent): void {
    const b = this.topics.get(topic) ?? { state: [], noise: [], done: false, updatedAt: 0 };
    if (isStateEvent(e)) {
      b.state.push(e);
      if (e.kind === "result") b.done = true;
    } else {
      b.noise.push(e);
      if (b.noise.length > this.noiseLimit) b.noise.splice(0, b.noise.length - this.noiseLimit);
    }
    b.updatedAt = Date.now();
    this.topics.set(topic, b);
  }

  /** 重连时先回放:noise 在前、state 在后,让前端先看到过程再落定状态。 */
  replay(topic: string): { events: AgentEvent[]; done: boolean } {
    const b = this.topics.get(topic);
    if (!b) return { events: [], done: false };
    return { events: [...b.noise, ...b.state], done: b.done };
  }

  /**
   * 按前缀合并回放 —— 一个会话下可能有多条并发运行,各自一个桶。
   *
   * 【为什么要分桶】缓冲曾经按会话存,于是同会话并发两轮时:后开始的那轮
   * `reset(会话)` 会把前一轮的整个缓冲删掉,用户刷新页面走 /events 也拿不回过程;
   * 反过来,先结束那轮的 result 会把整个会话标成 done,/events 回放完直接收流,
   * 即使另一轮还在跑。分桶到 run 粒度之后两边互不干扰。
   *
   * done 的语义相应变成"这个会话下已知的运行全部跑完"—— 只要还有一条没完,
   * 重连方就该继续挂着流。
   */
  replayScope(prefix: string): { events: AgentEvent[]; done: boolean; open: string[] } {
    const buckets = [...this.topics.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([, a], [, b]) => a.updatedAt - b.updatedAt);

    if (buckets.length === 0) return { events: [], done: false, open: [] };
    return {
      // 同一轮内仍是 noise 在前、state 在后;跨轮按时间先后拼接
      events: buckets.flatMap(([, b]) => [...b.noise, ...b.state]),
      done: buckets.every(([, b]) => b.done),
      // 还没收到终态的运行 —— 重连方要等它们全部收尾才能收流
      open: buckets.filter(([, b]) => !b.done).map(([k]) => k.slice(prefix.length)),
    };
  }

  /** 新一轮开始时清空,避免把上一轮的事件重放给这一轮。 */
  reset(topic: string): void {
    this.topics.delete(topic);
  }

  /** 清理久未更新的会话,防长期运行下无界增长。 */
  evictOlderThan(ms: number, now = Date.now()): number {
    let n = 0;
    for (const [topic, b] of this.topics) {
      if (now - b.updatedAt > ms) {
        this.topics.delete(topic);
        n++;
      }
    }
    return n;
  }
}
