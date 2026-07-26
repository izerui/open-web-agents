import type { AgentEvent } from "@/lib/shared";

export type Unsubscribe = () => void;

/** 事件总线。跨进程解耦 worker 与 web(SSE);MVP 内存实现,生产换 Redis pub/sub。 */
export interface BusPort {
  publish(topic: string, e: AgentEvent): Promise<void>;
  subscribe(topic: string, cb: (e: AgentEvent) => void): Unsubscribe;
}
