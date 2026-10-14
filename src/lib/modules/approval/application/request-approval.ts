// 引擎的人工审批钩子(worker 侧):先看本会话有没有同类授权,没有再挂起等人裁决。
//
// 【先推待审事件,再挂起】界面看得到才有人批;超时兜底在 ApprovalPort 实现里 ——
// 没人审批时到点自动拒,绝不永久占住 worker。
// 【同类授权读不到时去问人】授权是"少问一次"的便利,读不到不能变成"自动批准",
// 也不该让这次调用失败 —— 照常发起审批。

import type { AgentEvent } from "@/lib/shared";
import { type ApprovalOutcome, type ApprovalPort, ApprovalUnavailable } from "../ports";

export interface ApprovalCall {
  sessionId: string;
  runId?: string;
  toolName: string;
  summary: string;
  reason: string;
  /** 这次调用所属的全部类别(审批规则给出);每一类都已授权才自动放行 */
  scopes?: { key: string; label: string }[];
}

export interface RequestApprovalDeps {
  approval: ApprovalPort;
  /** 推到这次运行的事件流;失败不影响审批本身 */
  publish(sessionId: string, runId: string | undefined, e: AgentEvent): Promise<void>;
  newId(): string;
  now(): number;
  timeoutMs: number;
}

export async function requestApproval(
  deps: RequestApprovalDeps,
  r: ApprovalCall,
  signal?: AbortSignal,
): Promise<{ approved: boolean; message?: string }> {
  const say = (label: string, state: string) =>
    deps.publish(r.sessionId, r.runId, { kind: "status", label, state }).catch(() => {});

  const scopes = r.scopes ?? [];
  if (scopes.length > 0) {
    let granted = false;
    try {
      const have = new Set((await deps.approval.grants(r.sessionId)).map((g) => g.key));
      // 每一类都已授权才放行:复合命令里任何一类没授权,都要问人
      granted = scopes.every((s) => have.has(s.key));
    } catch {
      granted = false; // 读不到就去问人
    }
    if (granted) {
      await say(
        `已按本会话授权自动批准:${r.toolName} — ${r.summary}(${scopes.map((s) => s.label).join("、")})`,
        "approved_by_grant",
      );
      return { approved: true };
    }
  }

  const createdAt = deps.now();
  await say(`待审批:${r.toolName} — ${r.summary}(${r.reason})`, "awaiting_approval");

  let outcome: ApprovalOutcome;
  try {
    outcome = await deps.approval.request(
      {
        id: deps.newId(),
        sessionId: r.sessionId,
        runId: r.runId,
        toolName: r.toolName,
        summary: r.summary,
        reason: r.reason,
        ...(scopes.length > 0 ? { scopes } : {}),
        createdAt,
        expiresAt: createdAt + deps.timeoutMs,
      },
      // 运行被取消/超时中止时,这条待审请求要立刻收场并清掉记录 ——
      // 否则界面上它还挂着,用户点批准还会收到"已裁决",而运行早就没了
      signal,
    );
  } catch (err) {
    // 审批服务不可用:如实标成"无法确认",不冒充超时拒绝。异常继续抛给引擎,
    // 由它按 fail-closed 拒绝这次工具调用并带上原因
    if (err instanceof ApprovalUnavailable) {
      await say(`审批结果无法确认(审批服务不可用):${r.toolName}`, "approval_unavailable");
    }
    throw err;
  }

  await say(
    outcome.decision === "approved"
      ? `审批通过:${r.toolName}`
      : outcome.decision === "expired"
        ? `审批超时自动拒绝:${r.toolName}`
        : `审批被拒:${r.toolName}`,
    outcome.decision,
  );
  return {
    approved: outcome.decision === "approved",
    message:
      outcome.decision === "expired"
        ? "审批超时,已自动拒绝"
        : outcome.decision === "denied"
          ? (outcome.message ?? "人工审批未通过")
          : undefined,
  };
}
