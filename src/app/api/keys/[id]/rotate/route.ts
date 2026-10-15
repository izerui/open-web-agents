import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { canInvokeAgent } from "@/lib/modules/access/domain/principal";
import {
  generateApiKey,
  hashApiKey,
  isKeyExpired,
  parseGraceHours,
  rotationPlan,
} from "@/lib/modules/identity/domain/api-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 轮换一把 Key:签发一把同名、同绑定、同限额的新 Key,旧 Key 再有效一段重叠期(默认 24 小时)
 * 后失效 —— 集成方在重叠期内换上新 Key,不停机。body: { graceHours?: 0~168 }。
 *
 * 只能轮换自己的、还没过期的 Key。绑定了智能体的,要重新确认签发人仍有权使用它 ——
 * 轮换产生的是一把新凭证,不能借它把已经被撤销的权限延续下去。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { apiKeys, agents, grants, auth, audit } = getContainer();

  let ownerId: string;
  let subject: Awaited<ReturnType<typeof auth.subjectOf>>;
  try {
    const principal = await auth.resolveWeb(req);
    // 对外 Key 不能自己给自己续命
    auth.assertCanManageAgents(principal);
    subject = await auth.subjectOf(principal);
    ownerId = subject.userId;
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const old = await apiKeys.get(id);
  // 别人的与不存在的同一个 404:不让这个接口成为 Key id 的存在性预言机
  if (!old || old.ownerId !== ownerId) {
    return Response.json({ error: "key not found" }, { status: 404 });
  }
  const now = Date.now();
  if (isKeyExpired(old, now)) {
    return Response.json(
      { error: "这把 Key 已过期,请签发新的", code: "invalid_request" },
      { status: 409 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { graceHours?: unknown };
  const grace = parseGraceHours(body.graceHours);
  if (!grace.ok)
    return Response.json({ error: grace.reason, code: "invalid_request" }, { status: 400 });

  if (old.agentId) {
    const a = await agents.get(old.agentId);
    const list = await grants.listForResource("agent", old.agentId);
    if (!a || !canInvokeAgent(await auth.resolveWeb(req), a, subject, list).allowed) {
      return Response.json(
        { error: "已无权使用这把 Key 绑定的智能体,不能轮换", code: "forbidden" },
        { status: 403 },
      );
    }
  }

  const plan = rotationPlan(old, now, grace.hours);
  const plain = generateApiKey();
  const fresh = await apiKeys.create({
    id: randomUUID().replace(/-/g, "").slice(0, 24),
    ownerId,
    agentId: old.agentId,
    name: old.name,
    rateLimitPerMinute: old.rateLimitPerMinute,
    ...(plan.newExpiresAt ? { expiresAt: plan.newExpiresAt } : {}),
    hashedKey: hashApiKey(plain),
  });
  // 新 Key 先建好,再给旧 Key 定到期:中途失败最多多出一把新 Key,不会两把都不能用
  await apiKeys.setExpiry(old.id, plan.oldExpiresAt);

  await audit.record({
    actor: { type: "web", userId: ownerId },
    action: "api_key.rotate",
    resource: { type: "api_key", id: old.id },
    ownerId,
    details: {
      name: old.name,
      successorId: fresh.id,
      boundAgentId: old.agentId,
      oldExpiresAt: new Date(plan.oldExpiresAt).toISOString(),
    },
    req,
  });

  return Response.json(
    {
      key: fresh,
      /** 仅此一次可见 */
      plaintext: plain,
      previous: { id: old.id, expiresAt: new Date(plan.oldExpiresAt).toISOString() },
      hint: "请立刻保存新 Key,并在旧 Key 失效前换上",
    },
    { status: 201 },
  );
}
