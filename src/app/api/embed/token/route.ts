import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { EMBED_TTL_MS, issueEmbedToken } from "@/lib/modules/integration/domain/embed-token";
import { workspacePathFor } from "@/lib/modules/session/domain/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 企业后端(持有 API Key)换一枚短时效嵌入令牌,交给自家页面上的 widget。
 *
 * 这一步【必须在服务端做】—— 设计文稿 §8 的硬约束是 key 绝不下发浏览器。
 * 令牌绑定单个会话:泄露了也只能操作那一个会话,读不到别人的。
 */
export async function POST(req: Request) {
  const { agents, sessions, auth, env } = getContainer();

  let principal: Awaited<ReturnType<typeof auth.requireApiKey>>;
  try {
    principal = await auth.requireApiKey(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  // 这是第三方直接打进来的接口(API Key 鉴权),改名最不能在这里断人家的线。
  // assistantId 是改名前的字段名,回退一层;新调用方一律用 agentId。
  const body = (await req.json().catch(() => ({}))) as {
    agentId?: string;
    /* 旧字段,仅供回退 */
    assistantId?: string;
    title?: string;
  };
  const agentId = (body.agentId ?? body.assistantId)?.trim();
  if (!agentId) return Response.json({ error: "agentId is required" }, { status: 400 });

  try {
    await auth.assertCanInvoke(principal, agentId);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  if (!(await agents.get(agentId))) {
    return Response.json({ error: "agent not found" }, { status: 404 });
  }

  // 每枚令牌配一个新会话(= 独立工作目录),互不干扰
  const sessionId = randomUUID().replace(/-/g, "").slice(0, 24);
  const workspaceDir = workspacePathFor(env.dataDir, sessionId);
  await fs.mkdir(workspaceDir, { recursive: true });
  await sessions.create({
    id: sessionId,
    agentId,
    workspaceDir,
    title: body.title ?? "embed",
    callerApiKeyId: principal.type === "apiKey" ? principal.keyId : undefined,
  });

  const token = issueEmbedToken(
    env.sessionSecret,
    {
      agentId,
      sessionId,
      keyId: principal.type === "apiKey" ? principal.keyId : "web",
    },
    EMBED_TTL_MS,
  );

  return Response.json(
    {
      token,
      sessionId,
      expiresInMs: EMBED_TTL_MS,
      /** 直接可嵌入的地址 */
      embedUrl: `/embed?token=${encodeURIComponent(token)}`,
    },
    { status: 201 },
  );
}
