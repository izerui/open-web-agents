import type { ApprovalRequest } from "../ports";

/**
 * 一个会话的待审列表里,有几条是等你确认的工具调用、几条是等你回答的提问。
 * 对话页的会话列表据此给没打开的会话也标「待你确认 / 等你回答」。
 */
export function countWaits(pending: readonly Pick<ApprovalRequest, "questions">[]): {
  approvals: number;
  questions: number;
} {
  let questions = 0;
  for (const p of pending) if (p.questions?.length) questions += 1;
  return { approvals: pending.length - questions, questions };
}
