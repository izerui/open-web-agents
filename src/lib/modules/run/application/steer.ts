// 受理一条运行中途的追加消息(web 侧)。
//
// 答复必须如实:
//   delivered —— worker 确认已交给模型
//   not_accepting —— 运行还没开始受理或已经关闭输入,这条【没有】入队;调用方应当把它作为新一轮发送
//   dropped —— 入队了,但运行在交给模型之前就结束了;同样应当重发
//   pending —— 入队了,等待上限内没等到结局(worker 慢或通道抖动);最终结局由事件流里的
//              steer 事件告知(delivered / dropped)
// 绝不在没确认送达时答"已送达"。

import type { SteerChannel } from "@/lib/modules/run/ports";

export type SteerOutcome = "delivered" | "not_accepting" | "dropped" | "pending";

export interface SteerDeps {
  channel: Pick<SteerChannel, "offer" | "awaitOutcome">;
  newId: () => string;
  /** 等结局的上限。 */
  outcomeTimeoutMs?: number;
  /** 测试用的暂停点:入队成功之后、开始等结局之前。 */
  afterAccept?: () => Promise<void>;
}

export async function steerRun(
  deps: SteerDeps,
  req: { runId: string; text: string },
): Promise<{ id: string; outcome: SteerOutcome }> {
  const id = deps.newId();
  const accepted = await deps.channel.offer(req.runId, { id, text: req.text });
  if (accepted === "closed") return { id, outcome: "not_accepting" };
  await deps.afterAccept?.();
  let outcome: "delivered" | "dropped" | "pending";
  try {
    outcome = await deps.channel.awaitOutcome(req.runId, id, deps.outcomeTimeoutMs ?? 5_000);
  } catch {
    // 已经入队,只是查不到结局:不能答成失败(它可能已经送达),也不能答成功
    outcome = "pending";
  }
  return { id, outcome };
}
