import { randomUUID } from "node:crypto";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { hasResourceAccess } from "@/lib/modules/access/domain/grants";
import { validateKeyRateLimit } from "@/lib/modules/identity/application/invoke-rate-limit";
import { generateApiKey, hashApiKey } from "@/lib/modules/identity/domain/api-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * key 的归属【必须是当前登录用户】。
 *
 * 这里曾经硬编码成 WEB_USER_ID(那是「关闭登录的本地开发主体」常量),后果是三连:
 * 签发时所有人的 key 都记在同一个假 owner 名下 → 列表按同一常量过滤等于查全表
 * → 任意注册用户能枚举全平台的 key 并逐个吊销,一键瘫痪所有对接方。
 * 更隐蔽的是 subjectOf 会把所有 key 解析成同一身份,授权判定跟着一起失真。
 *
 * 教训:「本地开发兜底常量」漏进生产路径,比没有兜底更危险 —— 它让越权看起来像正常代码。
 */
async function currentUserId(req: Request): Promise<string> {
  return (await currentUser(req)).userId;
}

async function currentUser(req: Request): Promise<{ userId: string; isAdmin: boolean }> {
  const { auth } = getContainer();
  const principal = await auth.resolveWeb(req);
  // 对外 key 不能自我枚举/提权
  auth.assertCanManageAgents(principal);
  const subject = await auth.subjectOf(principal);
  return { userId: subject.userId, isAdmin: subject.role === "admin" };
}

/** 列出本账户的 key(只回元信息,永不回明文)。 */
export async function GET(req: Request) {
  const { apiKeys, env } = getContainer();
  try {
    return Response.json({
      keys: await apiKeys.list(await currentUserId(req)),
      // 平台默认的调用限流(0 = 不限),界面据此显示每把 Key 的实际上限
      rateLimits: {
        perKeyPerMinute: env.invokeRateLimitPerKey,
        perAgentPerMinute: env.invokeRateLimitPerAgent,
      },
    });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

/**
 * 签发一个新 key。
 * 明文【只在本次响应里返回一次】—— 库里只有哈希,丢了只能重新签发。
 */
export async function POST(req: Request) {
  const { apiKeys, agents, grants, auth, env, audit } = getContainer();

  let ownerId: string;
  let isAdmin: boolean;
  try {
    ({ userId: ownerId, isAdmin } = await currentUser(req));
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  // assistantId 是改名前的字段名,回退一层保住已接入的调用方。
  const raw = (await req.json().catch(() => ({}))) as {
    name?: string;
    agentId?: string;
    /* 旧字段,仅供回退 */
    assistantId?: string;
    /** 每分钟新调用上限;不传 = 平台默认 */
    rateLimitPerMinute?: number | null;
  };
  const body = { name: raw.name, agentId: raw.agentId ?? raw.assistantId };

  let rateLimitPerMinute: number | undefined;
  if (raw.rateLimitPerMinute !== undefined) {
    const v = validateKeyRateLimit(raw.rateLimitPerMinute, {
      isAdmin,
      platformDefault: env.invokeRateLimitPerKey,
    });
    if (!v.ok) return Response.json({ error: v.reason, code: "invalid_request" }, { status: 400 });
    rateLimitPerMinute = v.value ?? undefined;
  }

  // 绑定到具体智能体时,不仅要确认它存在,还要确认签发人对它有权限 ——
  // 否则等于把「越权运行他人智能体」从一次性利用固化成一把长期有效的专用凭证,
  // 而且那把 key 在受害者的界面上根本看不见。
  //
  // 存在与无权返回同一个 404:不区分二者,免得这个接口变成智能体 id 的存在性预言机。
  let boundAgentName: string | undefined;
  if (body.agentId) {
    const a = await agents.get(body.agentId);
    boundAgentName = a?.name;
    const subject = await auth.subjectOf(await auth.resolveWeb(req));
    const list = await grants.listForResource("agent", body.agentId);
    if (!a || !hasResourceAccess(subject, a, "read", list)) {
      return Response.json({ error: "agent not found" }, { status: 404 });
    }
  }

  const plain = generateApiKey();
  const record = await apiKeys.create({
    id: randomUUID().replace(/-/g, "").slice(0, 24),
    ownerId,
    agentId: body.agentId,
    name: body.name,
    rateLimitPerMinute,
    hashedKey: hashApiKey(plain),
  });

  await audit.record({
    actor: { type: "web", userId: ownerId },
    action: "api_key.issue",
    resource: { type: "api_key", id: record.id },
    ownerId,
    // 明文绝不进审计;只记元信息
    details: {
      name: record.name,
      boundAgentId: record.agentId,
      // 名称快照:智能体日后改名或删除,审计里仍看得懂
      boundAgentName,
      rateLimitPerMinute: record.rateLimitPerMinute,
    },
    req,
  });

  return Response.json(
    {
      key: record,
      /** 仅此一次可见 */
      plaintext: plain,
      hint: "请立刻保存;服务端只存哈希,无法再次显示",
    },
    { status: 201 },
  );
}

/** 吊销 key —— 只能吊销自己的。 */
export async function DELETE(req: Request) {
  const { apiKeys } = getContainer();

  let ownerId: string;
  try {
    ownerId = await currentUserId(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  // 归属校验必须在 revoke 之前 —— 这里曾经拿到 id 就直接删
  const record = await apiKeys.get(id);
  if (!record || record.ownerId !== ownerId) {
    return Response.json({ error: "key not found" }, { status: 404 });
  }

  await apiKeys.revoke(id);
  await getContainer().audit.record({
    actor: { type: "web", userId: ownerId },
    action: "api_key.revoke",
    resource: { type: "api_key", id },
    ownerId,
    details: { name: record.name, boundAgentId: record.agentId },
    req,
  });
  return Response.json({ revoked: id });
}

/**
 * 调整一把 Key 的每分钟调用上限(PATCH /api/keys?id=...,body: { rateLimitPerMinute: n | null })。
 * null 恢复平台默认;普通用户只能调得比平台默认更严。
 */
export async function PATCH(req: Request) {
  const { apiKeys, env } = getContainer();

  let user: { userId: string; isAdmin: boolean };
  try {
    user = await currentUser(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id)
    return Response.json({ error: "id is required", code: "invalid_request" }, { status: 400 });
  const record = await apiKeys.get(id);
  if (!record || record.ownerId !== user.userId) {
    return Response.json({ error: "key not found", code: "not_found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { rateLimitPerMinute?: unknown };
  if (!("rateLimitPerMinute" in body)) {
    return Response.json(
      { error: "rateLimitPerMinute is required", code: "invalid_request" },
      { status: 400 },
    );
  }
  const v = validateKeyRateLimit(body.rateLimitPerMinute, {
    isAdmin: user.isAdmin,
    platformDefault: env.invokeRateLimitPerKey,
  });
  if (!v.ok) return Response.json({ error: v.reason, code: "invalid_request" }, { status: 400 });

  await apiKeys.setRateLimit(id, v.value);
  await getContainer().audit.record({
    actor: { type: "web", userId: user.userId },
    action: "api_key.rate_limit",
    resource: { type: "api_key", id },
    ownerId: user.userId,
    details: { name: record.name, from: record.rateLimitPerMinute ?? null, to: v.value },
    req,
  });
  return Response.json({ key: await apiKeys.get(id) });
}
