import type { AgentEvent } from "@/lib/shared";

export type Unsubscribe = () => void;

export interface StreamSubscriptionOptions {
  /** 只读取此游标之后的事件。`0-0` 表示从当前保留窗口的开头读取。 */
  afterId?: string;
}

/** 持久事件流。跨进程解耦 worker 与 web(SSE),并提供短期断线回放。 */
export interface BusPort {
  /** 写入事件并返回可用于 SSE `id:` 的持久游标。 */
  publish(topic: string, e: AgentEvent): Promise<string>;
  subscribe(
    topic: string,
    cb: (e: AgentEvent, id: string) => void,
    options?: StreamSubscriptionOptions,
  ): Unsubscribe;
  /** 检查底层事件存储是否可用。 */
  ready?(): Promise<void>;
}
