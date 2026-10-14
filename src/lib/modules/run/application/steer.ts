// 受理一条运行中途的追加消息(web 侧)。
//
// 答复必须如实,只有明确的结论才让调用方采取不可撤回的动作:
//   delivered     —— worker 确认已交给模型
//   not_accepting —— 明确【没有】受理(运行还没开始受理或已关闭输入);可以作为新一轮发送
//   dropped       —— 受理了,但运行在交给模型前结束了;可以作为新一轮发送
//   pending       —— 已受理,等待上限内没等到结局;最终结局由事件流里的 steer 事件告知
//   unknown       —— 受理请求本身没得到答复(超时 / 连接问题):它可能已经入队,甚至之后才执行。
//                    【不能】当成没受理去重发 —— 用同一个 id 再问一次即可得到定局
//                    (同一 id 只入队一次;没受理时会留下记录,迟到执行的同 id 请求不会再入队)
// 绝不在没确认送达时答"已送达"。

import type { SteerChannel } from "@/lib/modules/run/ports";

export type SteerOutcome = "delivered" | "not_accepting" | "dropped" | "pending" | "unknown";

export interface SteerDeps {
  channel: Pick<SteerChannel, "offer" | "awaitOutcome">;
  /** 等结局的上限。 */
  outcomeTimeoutMs?: number;
  /** 测试用的暂停点:入队成功之后、开始等结局之前。 */
  afterAccept?: () => Promise<void>;
}

export async function steerRun(
  deps: SteerDeps,
  req: { runId: string; id: string; text: string },
): Promise<{ id: string; outcome: SteerOutcome }> {
  const { id } = req;
  let offered: Awaited<ReturnType<SteerChannel["offer"]>>;
  try {
    offered = await deps.channel.offer(req.runId, { id, text: req.text });
  } catch {
    return { id, outcome: "unknown" };
  }
  if (offered === "rejected") return { id, outcome: "not_accepting" };
  if (offered === "delivered" || offered === "dropped") return { id, outcome: offered };
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
