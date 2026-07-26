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
