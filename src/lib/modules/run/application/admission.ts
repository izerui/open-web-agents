// 在已有会话里"受理一轮新运行"的统一关卡:对话(sessions/run)、分支重跑(branch)都走这里。鉴权与权限复查由各入口按自己的凭证完成,之后统一:
//
//   会话存在且未删除 → 计费账号 → API Key 调用限流 → 额度 → 输入规范化与限长
//   → 输入契约(API Key 建的会话)
//
// 【为什么收拢】这几条规则曾经在四个路由里各写一遍,各漏一点:
// - 用 API Key 在会话里跑,同一个智能体走 invoke 要校验 inputSchema,走 sessions/run 什么都收;
// - Key 的调用限流只拦 invoke,同一把 Key 经 API 会话可以无限发起;
// - 没有计费账号时,run 回落到会话归属或调用方去查额度,branch 干脆跳过额度。
// invoke 自己建会话、且必须先做幂等重放,不走这里,但复用同一组限流与额度函数。

import { checkPromptSize } from "@/lib/modules/run/domain/limits";
import type { Session, SessionRepo } from "@/lib/modules/session/ports";
import { BrandedError, type JsonSchema } from "@/lib/shared";

/** 受理被拒。status / code 直接映射成 HTTP 响应。 */
export class AdmissionRejected extends BrandedError {
  static readonly brand = Symbol.for("owa.error.AdmissionRejected");
  constructor(
    readonly status: number,
    readonly code:
      | "not_found"
      | "invalid_request"
      | "input_invalid"
      | "prompt_too_large"
      | "rate_limited"
      | "quota_exceeded",
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** 发起这一轮的调用方。web = 登录用户;apiKey = API Key。 */
export type AdmissionCaller =
  | { type: "web"; userId: string }
  | { type: "apiKey"; keyId: string; ownerId: string; rateLimitPerMinute?: number };

export interface AdmissionDeps {
  sessions: Pick<SessionRepo, "get">;
  /** 超出月度额度时抛错(QuotaExceeded),由 quotaRejection 转成 402 */
  checkQuota(userId: string): Promise<void>;
  /** 每把 Key、每个智能体的调用限流;不提供 = 不限流 */
  checkRate?(input: {
    keyId: string;
    keyLimit?: number;
    agentId: string;
  }): Promise<
    | { allowed: true }
    | { allowed: false; scope: "key" | "agent"; limit: number; retryAfterMs: number }
  >;
  /** 会话锁定版本(或草稿)的 inputSchema;没有返回 undefined */
  inputSchemaOf(session: Session): Promise<JsonSchema | undefined>;
  validateInput(schema: JsonSchema, value: unknown): { ok: boolean; errors?: string[] };
  /** 识别额度异常(QuotaExceeded),转成受理拒绝 */
  quotaRejection(err: unknown): AdmissionRejected | null;
}

export interface AdmissionRequest {
  sessionId: string;
  caller: AdmissionCaller;
  /** 自然语言输入 */
  prompt?: unknown;
  /** 结构化输入(声明了 inputSchema 的智能体按它传) */
  input?: unknown;
}

export interface Admitted {
  session: Session;
  /** 规范化后的本轮输入(结构化输入序列化为 JSON) */
  prompt: string;
  billingUserId?: string;
}

export class RunAdmission {
  constructor(private readonly deps: AdmissionDeps) {}

  async admit(req: AdmissionRequest): Promise<Admitted> {
    const session = await this.deps.sessions.get(req.sessionId);
    // 已删除的会话视同不存在(各入口的会话校验之外再挡一次)
    if (!session || session.status === "deleted") {
      throw new AdmissionRejected(404, "not_found", "session not found");
    }

    // 计费账号:花费记给谁、额度就查谁(worker 也按它取凭证)。一条规则,四个入口一致
    const billingUserId =
      session.billingUserId ??
      session.ownerId ??
      (req.caller.type === "web" ? req.caller.userId : req.caller.ownerId);

    // 先查请求本身的形状,不合法的请求不占限流与额度
    const prompt = await this.normalizeInput(session, req);

    if (req.caller.type === "apiKey" && this.deps.checkRate) {
      const v = await this.deps.checkRate({
        keyId: req.caller.keyId,
        keyLimit: req.caller.rateLimitPerMinute,
        agentId: session.agentId,
      });
      if (!v.allowed) {
        const retryAfter = Math.max(1, Math.ceil(v.retryAfterMs / 1000));
        throw new AdmissionRejected(
          429,
          "rate_limited",
          v.scope === "key"
            ? `这把 API Key 每分钟最多发起 ${v.limit} 次新运行,请 ${retryAfter} 秒后再试`
            : `该智能体每分钟最多受理 ${v.limit} 次新运行(所有调用方合计),请 ${retryAfter} 秒后再试`,
          { scope: v.scope, limit: v.limit, retryAfterSeconds: retryAfter },
          { "Retry-After": String(retryAfter) },
        );
      }
    }

    if (billingUserId) {
      try {
        await this.deps.checkQuota(billingUserId);
      } catch (err) {
        const rejected = this.deps.quotaRejection(err);
        if (rejected) throw rejected;
        throw err;
      }
    }

    return { session, prompt, billingUserId };
  }

  /**
   * 输入规范化与契约校验。
   * API Key 建的会话(source=api)按会话锁定版本的 inputSchema 校验 —— 与 invoke 同一份契约;
   * 网页对话是人在聊天,输入就是自然语言,不套接口契约。
   */
  private async normalizeInput(session: Session, req: AdmissionRequest): Promise<string> {
    const schema = session.source === "api" ? await this.deps.inputSchemaOf(session) : undefined;

    if (schema) {
      if (req.input === undefined || typeof req.input === "string") {
        throw new AdmissionRejected(
          400,
          "input_invalid",
          "该智能体声明了 inputSchema:用 API Key 在会话里运行时,须传符合它的对象 input",
        );
      }
      const v = this.deps.validateInput(schema, req.input);
      if (!v.ok) {
        throw new AdmissionRejected(400, "input_invalid", "input 不符合该智能体的 inputSchema", {
          details: v.errors,
        });
      }
      return this.sized(JSON.stringify(req.input));
    }

    const raw =
      typeof req.prompt === "string"
        ? req.prompt
        : typeof req.input === "string"
          ? req.input
          : req.input !== undefined
            ? JSON.stringify(req.input)
            : "";
    const prompt = raw.trim();
    if (!prompt || prompt === "{}") {
      throw new AdmissionRejected(400, "invalid_request", "prompt is required");
    }
    return this.sized(prompt);
  }

  private sized(prompt: string): string {
    const v = checkPromptSize(prompt);
    if (!v.ok) throw new AdmissionRejected(413, "prompt_too_large", v.reason);
    return prompt;
  }
}
