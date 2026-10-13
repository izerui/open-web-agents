import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import type { Principal } from "@/lib/modules/access/domain/principal";
import type { ApprovalRequest } from "@/lib/modules/approval/ports";
import { ApprovalUnavailable } from "@/lib/modules/approval/ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 审批服务不可用 → 503,如实说明结果未知。
 * 整条路径上的每一次 Redis 读写都要落在这个处理里 —— 漏一处,断网时请求就挂住或变成 500。
 */
function unavailable(err: unknown): Response | null {
  return err instanceof ApprovalUnavailable
    ? Response.json({ error: err.message }, { status: 503 })
    : null;
}

/** 列出该会话的待审批请求。归属校验后才给看 —— 待审内容含命令与路径。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { approval, auth } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
    return Response.json({ pending: await approval.listPending(id) });
  } catch (err) {
    const down = unavailable(err);
    if (down) return down;
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

interface Body {
  approvalId?: string;
  decision?: "approved" | "denied";
  message?: string;
}

/**
 * 裁决一条待审请求。
 * 只有对会话有访问权的人能裁决 —— 否则任何人都能替别人批准危险操作。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { approval, auth } = getContainer();

  let by = "unknown";
  let principal: Principal;
  try {
    principal = await auth.resolveWeb(req);
    await auth.assertSessionAccess(principal, id);
    by = principal.type === "web" ? principal.userId : principal.keyId;
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  if (!body.approvalId) return Response.json({ error: "approvalId is required" }, { status: 400 });
  if (body.decision !== "approved" && body.decision !== "denied") {
    return Response.json({ error: "decision must be approved/denied" }, { status: 400 });
  }

  let ok: boolean;
  let target: ApprovalRequest | undefined;
  try {
    // 只能裁决属于本会话的请求,防止拿别会话的 id 越权批准
    const pending = await approval.listPending(id);
    target = pending.find((p) => p.id === body.approvalId);
    if (!target) {
      return Response.json({ error: "该待审请求不存在或已失效" }, { status: 404 });
    }
    ok = await approval.resolve(
      body.approvalId,
      body.decision === "approved"
        ? { decision: "approved", by }
        : { decision: "denied", by, message: body.message },
    );
  } catch (err) {
    // 审批服务不可用:如实告诉审批人"结果未知",而不是让他以为批成了或被拒了
    const down = unavailable(err);
    if (down) return down;
    throw err;
  }
  if (!ok) return Response.json({ error: "该待审请求已失效" }, { status: 409 });

  /*
   * 谁、在哪次运行里、对哪个工具做了什么裁决 —— 审批最需要事后能追溯。
   *
   * 【只记这几个字段】待审请求的摘要是工具调用的原文(Bash 就是截断后的命令,
   * 其它工具是入参 JSON),里面可能有令牌、密码:`curl -H 'Authorization: Bearer …'`。
   * 审批人的备注也是自由文本。按字段名打码管不到字符串内容,所以干脆不记。
   * 需要看原文时去运行详情里看 —— 那里有访问控制,审计日志的可见范围更宽。
   */
  // 归属查询只为审计服务,放进 record 的构造函数里,与写入一起受总上限约束 ——
  // 裁决已经落地,数据库再慢也不能让批准请求挂住
  const { sessions, audit } = getContainer();
  await audit.record(async () => {
    const session = await sessions.get(id).catch(() => null);
    return {
      actor: principal,
      action: "approval.decide",
      resource: { type: "session", id },
      ownerId: session?.billingUserId ?? session?.ownerId,
      details: {
        approvalId: body.approvalId,
        runId: target?.runId,
        tool: target?.toolName,
        decision: body.decision,
      },
      req,
    };
  });

  return Response.json({ resolved: body.approvalId, decision: body.decision });
}
