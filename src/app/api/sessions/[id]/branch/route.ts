import { randomUUID } from "node:crypto";
import { admissionErrorResponse, callerOf } from "@/app/api/_lib/admission";
import { apiError, chargeErrorResponse } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import type { Principal } from "@/lib/modules/access/domain/principal";
import { PromptTooLarge } from "@/lib/modules/run/application/enqueue";
import { type BranchMode, anchorForBranch } from "@/lib/modules/run/domain/branching";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 列出会话内的运行(含分支关系),供界面画分支树与提供重跑入口。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { runs, auth } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
    return Response.json({ runs: await runs.listBySession(id) });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

interface Body {
  /** 从哪个运行分叉。 */
  fromRunId?: string;
  /** fresh = 从零重开(默认);continue = 接着当前状态再跑一轮。 */
  mode?: BranchMode;
  prompt?: string;
}

/**
 * 重跑某一轮。
 *
 * fresh 模式不 resume,给一个干净上下文重来 —— 这是"跑歪了换个说法再试"的正解。
 * 新运行带上自己的锚点意图,编排层会优先用它而非会话最新状态,故不会串回主线。
 *
 * 注意:真正的"回到中间某轮再分叉"当前 SDK 做不到(session id 不是时间点快照),
 * 详见 domain/branching.ts 顶部说明。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { runs, auth, sessions, enqueuer, admission } = getContainer();

  let principal: Principal;
  try {
    principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
    const session = await sessions.get(id);
    if (!session) return apiError(404, "not_found", "session not found");
    // 分享被撤销后不能借原会话继续跑
    await auth.assertCanInvoke(principal, session.agentId);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as Body & { input?: unknown };
  if (!body.fromRunId) return apiError(400, "invalid_request", "fromRunId is required");
  const mode: BranchMode =
    body.mode === "continue" ? "continue" : body.mode === "rewind" ? "rewind" : "fresh";

  // 重跑同样花钱、同样要守契约 —— 与对话走同一个受理关卡
  let prompt: string;
  try {
    ({ prompt } = await admission.admit({
      sessionId: id,
      caller: callerOf(principal),
      prompt: body.prompt,
      input: body.input,
    }));
  } catch (err) {
    const res = admissionErrorResponse(err);
    if (res) return res;
    throw err;
  }

  // 只能从本会话内的运行分叉,防止拿别会话的 runId 越权续接其上下文
  const list = await runs.listBySession(id);
  const target = list.find((r) => r.id === body.fromRunId);
  if (!target) return apiError(404, "not_found", "该运行不属于本会话或不存在");

  const anchor = anchorForBranch(target, mode, list);
  if (!anchor.ok) return apiError(409, anchor.code ?? "invalid_request", anchor.reason);

  const runId = randomUUID().replace(/-/g, "").slice(0, 24);
  try {
    await enqueuer.enqueue({
      runId,
      sessionId: id,
      prompt,
      parentRunId: anchor.parentRunId,
      resumeAnchor: anchor.resumeAnchor,
      resumeAt: anchor.resumeAt,
    });
  } catch (err) {
    if (err instanceof PromptTooLarge) return apiError(413, "prompt_too_large", err.message);
    const charge = chargeErrorResponse(err);
    if (charge) return charge;
    throw err;
  }

  return Response.json(
    { runId, parentRunId: anchor.parentRunId, mode, resumeAnchor: anchor.resumeAnchor ?? null },
    { status: 202 },
  );
}
