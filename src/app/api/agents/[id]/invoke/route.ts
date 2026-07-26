import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { workspacePathFor } from "@/lib/modules/session/domain/workspace";
import type { ModelAlias } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InvokeBody {
  /** 符合助手 inputSchema 的输入;字符串则直接当 prompt。 */
  input?: unknown;
  /** 请求级覆盖(三级链最高优先)。 */
  override?: { baseUrl?: string; key?: string; model?: ModelAlias };
}

/**
 * 对外触发接口:第三方系统(Java/Go/Python/C)调这里跑一次助手。
 * 需要 `X-Api-Key`(或 `Authorization: Bearer`)。
 *
 * 与网页对话共用同一运行内核 —— 只是入站 adapter 与结果投递方式不同
 * (设计文档 §3 统一接口原则)。异步返回 taskId,结果用 GET result 轮询。
 *
 * 路径段命名注记:设计文档把 URL 定为 /api/agents/{assistantId}/invoke 与
 * /api/agents/{taskId}/result —— 同一层两种语义。Next 的文件路由不允许同层用不同 slug 名,
 * 故统一用 [id],URL 与文档保持一致,语义由各路由自述(此处 id = assistantId)。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: assistantId } = await params;
  const { assistants, sessions, runs, env, auth } = getContainer();

  let principal: Awaited<ReturnType<typeof auth.requireApiKey>>;
  try {
    principal = await auth.requireApiKey(req);
    await auth.assertCanInvoke(principal, assistantId);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const assistant = await assistants.get(assistantId);
  if (!assistant) {
    return Response.json({ error: "assistant not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as InvokeBody;
  const prompt =
    typeof body.input === "string" ? body.input.trim() : JSON.stringify(body.input ?? {});
  if (!prompt || prompt === "{}") {
    return Response.json({ error: "input is required" }, { status: 400 });
  }

  // 每次 invoke 开一个新会话(= 独立工作目录),互不干扰;归属记到发起的 key 上
  const sessionId = randomUUID().replace(/-/g, "").slice(0, 24);
  const workspaceDir = workspacePathFor(env.dataDir, sessionId);
  await fs.mkdir(workspaceDir, { recursive: true });
  await sessions.create({
    id: sessionId,
    assistantId,
    workspaceDir,
    title: "invoke",
    callerApiKeyId: principal.type === "apiKey" ? principal.keyId : undefined,
    ownerId: principal.type === "web" ? principal.userId : undefined,
  });

  const taskId = randomUUID().replace(/-/g, "").slice(0, 24);
  await runs.create({ id: taskId, sessionId, prompt });

  return Response.json(
    {
      taskId,
      sessionId,
      /** 有 outputSchema 才会返回结构化结果,否则只有文本 summary */
      structured: assistant.config.outputSchema !== undefined,
    },
    { status: 202 },
  );
}
