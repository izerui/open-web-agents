import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { VersionNotFound } from "@/lib/modules/agent/application/releases";
import { parseVersion } from "@/lib/modules/agent/domain/release";
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
  /** 锁定智能体版本;不传 = 当前发布的版本(从未发布则为草稿)。 */
  version?: number;
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
  const { agents, sessions, runs, env, auth, users, usage, enqueuer, releases } = getContainer();

  /*
   * 关卡顺序:
   *   鉴权与权限复查(每个请求都要过,重放也不例外 —— 吊销的 Key 拿不回任何东西)
   *   → 请求形状与摘要 → 幂等重放
   *   → 【只对新请求】额度、版本解析、契约校验、入队。
   * 额度(以及之后的调用限流)只约束"新开一次运行";重放不产生新的执行和花费,
   * 拦它只会让调用方拿不回已经受理、甚至已经扣过费的任务。
   */
  let principal: Awaited<ReturnType<typeof auth.requireApiKey>>;
  try {
    principal = await auth.requireApiKey(req);
    await auth.assertCanInvoke(principal, agentId);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
  // 花费记在签发这把 key 的账号头上,额度自然也按它算
  const billingUserId = principal.type === "apiKey" ? principal.ownerId : principal.userId;

  const agent = await agents.get(agentId);
  if (!agent) {
    return apiError(404, "not_found", "agent not found");
  }

  const body = (await req.json().catch(() => ({}))) as InvokeBody;

  // ── 第一步:只看请求本身的形状(与版本无关),算出请求摘要 ─────────────────────
  const prompt =
    typeof body.input === "string" ? body.input.trim() : JSON.stringify(body.input ?? {});
  if (!prompt || prompt === "{}") {
    return apiError(400, "input_invalid", "input is required");
  }

  /*
   * 请求级凭证覆盖(三级链最高优先)。
   * 曾经在这里解析完就丢了:入队只存了 prompt,worker 永远拿不到它,
   * 调用方以为用了自己的 key,实际跑的是别的凭证,且没有任何报错。
   */
  const override = parseOverride(body.override);
  if (!override.ok) return apiError(400, "invalid_request", override.reason);

  const requested = parseVersion(body.version);
  if (!requested.ok) return apiError(400, "invalid_request", "version 须为正整数");

  // 同键重放时用来判断"是不是同一个请求";请求体里的 version 也算请求内容
  const requestHash = sha256(
    JSON.stringify({ prompt, override: override.value ?? null, version: requested.value ?? null }),
  );

  // ── 第二步:幂等重放 —— 必须在解析当前版本、校验契约【之前】 ───────────────────
  /*
   * 调用方因超时重试同一个请求时带上同一个 Idempotency-Key,拿回的是第一次受理的任务,
   * 而不是又跑一次、又扣一次费。键按调用方 + 智能体隔离。
   *
   * 【为什么要排在版本解析之前】不指定版本的请求按 v1 受理后,作者发布了 schema 不兼容的 v2;
   * 原请求原键重试若先按"当前发布版本"校验,会被 v2 拒成 400,拿不回已经受理的任务 ——
   * 恰恰是幂等键要保证的场景。重放只认原任务:原版本、原快照决定的结果形态。
   */
  const rawKey = req.headers.get("Idempotency-Key")?.trim();
  let idempotencyKey: string | undefined;
  if (rawKey) {
    if (!isValidIdempotencyKey(rawKey)) {
      return apiError(
        400,
        "idempotency_key_invalid",
        "Idempotency-Key 须为 1~128 个可见 ASCII 字符",
      );
    }
    // 作用域 = 调用方 + 智能体:同一个键换一个智能体调用,不该拿回另一个智能体的任务。
    // 存摘要而不是原文:拼起来可能超过列宽
    const scope = principal.type === "apiKey" ? `k:${principal.keyId}` : `u:${principal.userId}`;
    idempotencyKey = sha256(`${scope}|${agentId}|${rawKey}`);
    const existing = await runs.findByIdempotencyKey(idempotencyKey);
    if (existing) return replayed(existing, requestHash, agent.config.outputSchema !== undefined);
  }

  // ── 第三步:新请求 —— 额度,再解析这次跑哪一版、按那一版校验契约 ───────────────────
  /*
   * 额度关卡 —— 对外接口尤其需要:invoke 是给第三方系统轮询调用的,
   * 对方的一个死循环就能在几分钟内烧掉整月预算,而且没有人盯着屏幕。
   * 放在幂等重放之后:首次受理的那次运行可能恰好把额度用完,原键重试仍要拿回原任务。
   */
  try {
    await assertWithinQuota({ users, usage }, billingUserId);
  } catch (err) {
    const quota = quotaErrorResponse(err);
    if (quota) return quota;
    throw err;
  }

  /*
   * 入参校验、结构化结果的有无都以【这一版】为准 ——
   * 草稿里刚改的 inputSchema 不该影响还在用已发布版本的调用方。
   */
  let release: Awaited<ReturnType<typeof releases.resolve>>;
  try {
    release = await releases.resolve(agent, requested.value);
  } catch (err) {
    if (err instanceof VersionNotFound) return apiError(404, "not_found", err.message);
    throw err;
  }
  const structured = release.config.outputSchema !== undefined;

  /**
   * 入站契约校验。智能体声明了 inputSchema,调用方就必须按它传。
   *
   * 【为什么必须早失败】不校验的话,一个字段拼错的请求会被原样塞进提示词,
   * agent 照跑不误,最后产出一个看起来正常、实际答非所问的结果 ——
   * 调用方拿到 200 和一份结构合规的 JSON,根本意识不到自己传错了,还白花一次模型钱。
   * 直接说清楚错在哪个字段,比事后对着结果猜便宜得多。
   */
  const inputSchema = release.config.inputSchema;
  if (inputSchema) {
    // 纯文本对上 object schema 必然不合格,提示要说人话
    if (typeof body.input === "string") {
      return apiError(
        400,
        "input_invalid",
        "该智能体声明了 inputSchema,input 必须是符合它的对象,不能是纯文本",
      );
    }
    const verdict = validateInput(inputSchema, body.input);
    if (!verdict.ok) {
      return apiError(400, "input_invalid", "input 不符合该智能体的 inputSchema", {
        details: verdict.errors,
      });
    }
  }

  try {
    assertPromptSize(prompt);
  } catch (err) {
    if (err instanceof PromptTooLarge) {
      return apiError(413, "prompt_too_large", err.message);
    }
    throw err;
  }

  // 每次 invoke 开一个新会话(= 独立工作目录),互不干扰;归属记到发起的 key 上
  const sessionId = randomUUID().replace(/-/g, "").slice(0, 24);
  const workspaceDir = workspacePathFor(env.dataDir, sessionId);
  await fs.mkdir(workspaceDir, { recursive: true });
  await sessions.create({
    id: sessionId,
    agentId,
    workspaceDir,
    title: "invoke",
    unattended: true,
    source: "invoke",
    callerApiKeyId: principal.type === "apiKey" ? principal.keyId : undefined,
    ownerId: principal.type === "web" ? principal.userId : undefined,
    // 花费记在签发 key 的账号上:额度按它算,模型凭证也用它自带的
    billingUserId,
    agentVersion: release.version ?? undefined,
  });

  const taskId = randomUUID().replace(/-/g, "").slice(0, 24);
  try {
    await enqueuer.enqueue({
      runId: taskId,
      sessionId,
      prompt,
      override: override.value,
      idempotencyKey,
      idempotencyHash: idempotencyKey ? requestHash : undefined,
    });
  } catch (err) {
    // 入队失败就回滚刚建的会话与目录,不留空壳
    await sessions.delete(sessionId).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    if (err instanceof DuplicateIdempotencyKey) {
      // 并发的同键请求:另一个先入队了,返回它
      const existing = await runs.findByIdempotencyKey(err.idempotencyKey);
      if (existing) {
        return replayed(existing, requestHash, agent.config.outputSchema !== undefined);
      }
    }
    throw err;
  }

  return Response.json(
    {
      taskId,
      sessionId,
      /** 有 outputSchema 才会返回结构化结果,否则只有文本 summary */
      structured,
      /** 实际执行的版本;null = 草稿(该智能体从未发布) */
      agentVersion: release.version,
    },
    { status: 202 },
  );
}

/**
 * 同一幂等键的重复请求:返回第一次受理的任务。200 而非 202,让调用方知道这是重放。
 * 版本与结果形态取自【原任务】;快照缺失的旧任务(版本功能之前受理)才回退到当前草稿判断。
 */
function replayed(
  run: {
    id: string;
    sessionId: string;
    idempotencyHash?: string;
    agentVersion?: number;
    hasOutputSchema?: boolean;
  },
  requestHash: string,
  legacyStructured: boolean,
): Response {
  // 同一个键配了不同的请求体:多半是调用方复用键的 bug,明确报错而不是返回别的任务
  if (run.idempotencyHash && run.idempotencyHash !== requestHash) {
    return apiError(
      422,
      "idempotency_conflict",
      "这个 Idempotency-Key 已用于另一个不同内容的请求",
      { taskId: run.id },
    );
  }
  return Response.json(
    {
      taskId: run.id,
      sessionId: run.sessionId,
      structured: run.hasOutputSchema ?? legacyStructured,
      agentVersion: run.agentVersion ?? null,
      replayed: true,
    },
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
  // 自定义网关必须自带 key:否则平台 key 会被发往调用方指定的地址(凭证链同层绑定)
  if (out.baseUrl && !out.key) {
    return { ok: false, reason: "override.baseUrl 必须与 override.key 一起提供" };
  }
  return { ok: true, value: Object.keys(out).length ? out : undefined };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
