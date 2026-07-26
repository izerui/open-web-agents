import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
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
  const { runs, auth } = getContainer();

  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const prompt = body.prompt?.trim();
  if (!body.fromRunId) return Response.json({ error: "fromRunId is required" }, { status: 400 });
  if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 });
  const mode: BranchMode = body.mode === "continue" ? "continue" : "fresh";

  // 只能从本会话内的运行分叉,防止拿别会话的 runId 越权续接其上下文
  const list = await runs.listBySession(id);
  const target = list.find((r) => r.id === body.fromRunId);
  if (!target) {
    return Response.json({ error: "该运行不属于本会话或不存在" }, { status: 404 });
  }

  const anchor = anchorForBranch(target, mode);
  if (!anchor.ok) return Response.json({ error: anchor.reason }, { status: 409 });

  const runId = randomUUID().replace(/-/g, "").slice(0, 24);
  await runs.create({
    id: runId,
    sessionId: id,
    prompt,
    parentRunId: anchor.parentRunId,
    resumeAnchor: anchor.resumeAnchor,
  });

  return Response.json(
    { runId, parentRunId: anchor.parentRunId, mode, resumeAnchor: anchor.resumeAnchor ?? null },
    { status: 202 },
  );
}
