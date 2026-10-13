import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { validateInput } from "@/lib/modules/agent/domain/validate-output";
import { PromptTooLarge, assertPromptSize } from "@/lib/modules/run/application/enqueue";
import { isValidIdempotencyKey } from "@/lib/modules/run/domain/limits";
import { DuplicateIdempotencyKey } from "@/lib/modules/run/ports";
import { workspacePathFor } from "@/lib/modules/session/domain/workspace";
import { assertWithinQuota, quotaErrorResponse } from "@/lib/modules/usage/application/quota-guard";
import { type ModelAlias, isModelAlias } from "@/lib/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface InvokeBody {
  /** 符合智能体 inputSchema 的输入;字符串则直接当 prompt。 */
  input?: unknown;
  /** 请求级覆盖(三级链最高优先)。 */
  override?: { baseUrl?: string; key?: string; model?: ModelAlias };
}

/**
 * 对外触发接口:第三方系统(Java/Go/Python/C)调这里跑一次智能体。
 * 需要 `X-Api-Key`(或 `Authorization: Bearer`)。
 *
 * 与网页对话共用同一运行内核 —— 只是入站 adapter 与结果投递方式不同
 * (设计文档 §3 统一接口原则)。异步返回 taskId,结果用 GET result 轮询。
 *
 * 路径段命名注记:设计文档把 URL 定为 /api/agents/{agentId}/invoke 与
 * /api/agents/{taskId}/result —— 同一层两种语义。Next 的文件路由不允许同层用不同 slug 名,
 * 故统一用 [id],URL 与文档保持一致,语义由各路由自述(此处 id = agentId)。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: agentId } = await params;
  const { agents, sessions, runs, env, auth, users, usage, enqueuer } = getContainer();

  let principal: Awaited<ReturnType<typeof auth.requireApiKey>>;
  let billingUserId: string;
  try {
    principal = await auth.requireApiKey(req);
    await auth.assertCanInvoke(principal, agentId);

    /*
     * 额度关卡 —— 对外接口尤其需要。
     *
     * 【为什么这条路径比 web 更要紧】invoke 是给第三方系统轮询调用的,
     * 对方的一个死循环就能在几分钟内烧掉整月预算,而且没有人盯着屏幕。
     * 花费记在签发这把 key 的账号头上,额度自然也按它算。
     */
    // requireApiKey 的返回类型是 Principal 联合类型,这里窄化一下拿归属账号
    billingUserId = principal.type === "apiKey" ? principal.ownerId : principal.userId;
    await assertWithinQuota({ users, usage }, billingUserId);
  } catch (err) {
    const quota = quotaErrorResponse(err);
    if (quota) return quota;
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const agent = await agents.get(agentId);
  if (!agent) {
    return Response.json({ error: "agent not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as InvokeBody;
  const prompt =
    typeof body.input === "string" ? body.input.trim() : JSON.stringify(body.input ?? {});
  if (!prompt || prompt === "{}") {
    return Response.json({ error: "input is required" }, { status: 400 });
  }

  /**
   * 入站契约校验。智能体声明了 inputSchema,调用方就必须按它传。
   *
   * 【为什么必须早失败】不校验的话,一个字段拼错的请求会被原样塞进提示词,
   * agent 照跑不误,最后产出一个看起来正常、实际答非所问的结果 ——
   * 调用方拿到 200 和一份结构合规的 JSON,根本意识不到自己传错了,还白花一次模型钱。
   * 直接说清楚错在哪个字段,比事后对着结果猜便宜得多。
   */
  const inputSchema = agent.config.inputSchema;
  if (inputSchema) {
    // 纯文本对上 object schema 必然不合格,提示要说人话
    if (typeof body.input === "string") {
      return Response.json(
        { error: "该智能体声明了 inputSchema,input 必须是符合它的对象,不能是纯文本" },
        { status: 400 },
      );
    }
    const verdict = validateInput(inputSchema, body.input);
    if (!verdict.ok) {
      return Response.json(
        { error: "input 不符合该智能体的 inputSchema", details: verdict.errors },
        { status: 400 },
      );
    }
  }

  // 每次 invoke 开一个新会话(= 独立工作目录),互不干扰;归属记到发起的 key 上
  try {
    assertPromptSize(prompt);
  } catch (err) {
    if (err instanceof PromptTooLarge) {
      return Response.json({ error: err.message }, { status: 413 });
    }
    throw err;
  }

  /*
   * 请求级凭证覆盖(三级链最高优先)。
   * 曾经在这里解析完就丢了:入队只存了 prompt,worker 永远拿不到它,
   * 调用方以为用了自己的 key,实际跑的是别的凭证,且没有任何报错。
   */
  const override = parseOverride(body.override);
  if (!override.ok) return Response.json({ error: override.reason }, { status: 400 });

  /*
   * 幂等键。调用方因超时重试同一个请求时带上同一个 Idempotency-Key,
   * 拿回的是第一次受理的任务,而不是又跑一次、又扣一次费。
   * 键按调用方隔离:不同 key / 不同账号用同样的字符串不会撞在一起。
   */
  const rawKey = req.headers.get("Idempotency-Key")?.trim();
  let idempotencyKey: string | undefined;
  if (rawKey) {
    if (!isValidIdempotencyKey(rawKey)) {
      return Response.json(
        { error: "Idempotency-Key 须为 1~128 个可见 ASCII 字符" },
        { status: 400 },
      );
    }
    const scope = principal.type === "apiKey" ? `k:${principal.keyId}` : `u:${principal.userId}`;
    idempotencyKey = `${scope}:${rawKey}`;
    const existing = await runs.findByIdempotencyKey(idempotencyKey);
    if (existing) return replayed(existing, agent.config.outputSchema !== undefined);
  }

  const sessionId = randomUUID().replace(/-/g, "").slice(0, 24);
  const workspaceDir = workspacePathFor(env.dataDir, sessionId);
  await fs.mkdir(workspaceDir, { recursive: true });
  await sessions.create({
    id: sessionId,
    agentId,
    workspaceDir,
    title: "invoke",
    unattended: true,
    callerApiKeyId: principal.type === "apiKey" ? principal.keyId : undefined,
    ownerId: principal.type === "web" ? principal.userId : undefined,
    // 花费记在签发 key 的账号上:额度按它算,模型凭证也用它自带的
    billingUserId,
  });

  const taskId = randomUUID().replace(/-/g, "").slice(0, 24);
  try {
    await enqueuer.enqueue({
      runId: taskId,
      sessionId,
      prompt,
      override: override.value,
      idempotencyKey,
    });
  } catch (err) {
    // 入队失败就回滚刚建的会话与目录,不留空壳
    await sessions.delete(sessionId).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    if (err instanceof DuplicateIdempotencyKey) {
      // 并发的同键请求:另一个先入队了,返回它
      const existing = await runs.findByIdempotencyKey(err.idempotencyKey);
      if (existing) return replayed(existing, agent.config.outputSchema !== undefined);
    }
    throw err;
  }

  return Response.json(
    {
      taskId,
      sessionId,
      /** 有 outputSchema 才会返回结构化结果,否则只有文本 summary */
      structured: agent.config.outputSchema !== undefined,
    },
    { status: 202 },
  );
}

/** 同一幂等键的重复请求:返回第一次受理的任务。200 而非 202,让调用方知道这是重放。 */
function replayed(run: { id: string; sessionId: string }, structured: boolean): Response {
  return Response.json(
    { taskId: run.id, sessionId: run.sessionId, structured, replayed: true },
    { status: 200 },
  );
}

type Override = { baseUrl?: string; key?: string; model?: ModelAlias };

function parseOverride(
  raw: unknown,
): { ok: true; value?: Override } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "override 必须是对象" };
  }
  const o = raw as Record<string, unknown>;
  const out: Override = {};
  if (o.baseUrl !== undefined) {
    if (typeof o.baseUrl !== "string" || o.baseUrl.length > 512) {
      return { ok: false, reason: "override.baseUrl 须为不超过 512 字符的字符串" };
    }
    const protocol = URL.canParse(o.baseUrl) ? new URL(o.baseUrl).protocol : "";
    if (protocol !== "https:" && protocol !== "http:") {
      return { ok: false, reason: "override.baseUrl 须为 http/https 地址" };
    }
    out.baseUrl = o.baseUrl;
  }
  if (o.key !== undefined) {
    if (typeof o.key !== "string" || !o.key.trim() || o.key.length > 512) {
      return { ok: false, reason: "override.key 须为不超过 512 字符的非空字符串" };
    }
    out.key = o.key.trim();
  }
  if (o.model !== undefined) {
    if (typeof o.model !== "string" || !isModelAlias(o.model)) {
      return { ok: false, reason: "override.model 不是已知的模型别名" };
    }
    out.model = o.model;
  }
  return { ok: true, value: Object.keys(out).length ? out : undefined };
}
