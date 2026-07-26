import type { AgentEvent } from "@/lib/shared";

export type Unsubscribe = () => void;

/** 事件总线。跨进程解耦 worker 与 web(SSE)。 */
export interface BusPort {
  publish(topic: string, e: AgentEvent): Promise<void>;
  subscribe(topic: string, cb: (e: AgentEvent) => void): Unsubscribe;
  /**
   * 等待订阅在底层真正生效。
   *
   * Redis 的 SUBSCRIBE 是异步往返的:subscribe() 返回时订阅可能还没注册到服务端,
   * 此时发布的消息会静默丢失。"先订阅再触发运行"的调用方必须先 await 它。
   * 进程内实现订阅即时生效,可省略。
   */
  ready?(topic: string): Promise<void>;
}
