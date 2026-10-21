// 智能体向用户提问(AskUserQuestion)时,在同一轮里等用户回答(worker 侧)。
//
// 【为什么要等】平台曾经对提问直接放行,SDK 立刻告诉模型"用户没有回答",模型按自己的猜测做完,
// 而界面上还挂着"等你选择" —— 用户点了选项,智能体早已按猜的做完了
// (实测见 scripts/sdk-probe/ask-user-question.mjs)。
//
// 复用审批的跨进程通道:登记一条带题目的待回答,界面在对话里的提问卡片上作答,答案随裁决带回。
// 有界等待(与审批同一个上限):没人答、运行被停止、通道不可用,都不卡住运行 ——
// 模型得到"用户没有回答",按自己的判断继续。

import type { AgentEvent, AskedQuestion } from "@/lib/shared";
import type { ApprovalPort } from "../ports";

export interface AskUserCall {
  sessionId: string;
  runId?: string;
  toolUseId?: string;
  questions: AskedQuestion[];
}

export interface AskUserDeps {
  approval: ApprovalPort;
  /** 推到这次运行的事件流;失败不影响等待本身 */
  publish(sessionId: string, runId: string | undefined, e: AgentEvent): Promise<void>;
  newId(): string;
  now(): number;
  timeoutMs: number;
}

/**
 * answers:用户的回答(键为问题原文);declined:用户选择不回答(可带一句说明)。
 * 两者都没有 = 没有回答(超时、运行被停止、通道不可用)
 */
export type AskUserOutcome = { answers?: Record<string, string>; declined?: string };

export async function askUser(
  deps: AskUserDeps,
  r: AskUserCall,
  signal?: AbortSignal,
): Promise<AskUserOutcome> {
  const say = (label: string, state: string) =>
    deps.publish(r.sessionId, r.runId, { kind: "status", label, state }).catch(() => {});
  const createdAt = deps.now();
  await say("等你回答智能体的提问", "awaiting_answer");
  try {
    const outcome = await deps.approval.request(
      {
        id: deps.newId(),
        sessionId: r.sessionId,
        runId: r.runId,
        toolName: "AskUserQuestion",
        summary: r.questions
          .map((q) => q.question)
          .join(" / ")
          .slice(0, 300),
        reason: "智能体在等你回答",
        questions: r.questions,
        ...(r.toolUseId ? { toolUseId: r.toolUseId } : {}),
        createdAt,
        expiresAt: createdAt + deps.timeoutMs,
      },
      signal,
    );
    if (outcome.decision === "approved" && outcome.answers) {
      await say("已收到你的回答", "answered");
      return { answers: outcome.answers };
    }
    if (outcome.decision === "denied") {
      await say("你选择不回答,智能体会自行判断", "answer_declined");
      return { declined: outcome.message ?? "" };
    }
    await say(
      signal?.aborted ? "运行已停止,提问未回答" : "等待回答超时,智能体会自行判断",
      "answer_expired",
    );
    return {};
  } catch {
    // 通道不可用:不能让提问卡住运行,也不能编造答案 —— 当作没有回答
    await say("提问通道不可用,智能体会自行判断", "answer_unavailable");
    return {};
  }
}
