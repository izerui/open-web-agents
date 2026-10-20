import type { ProbeResult, ProviderProbe } from "../ports";

const TIMEOUT_MS = 15_000;
const MAX_BODY = 2048;

/** 从上游错误里取一句可读的说明;Key 可能被回显,一律抹掉。 */
function summarize(body: string, key: string): string {
  let text = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") text = parsed.error.message;
  } catch {
    // 非 JSON:原文截断
  }
  if (key) text = text.split(key).join("***");
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * 与运行时同一路径:`{baseUrl}/v1/messages`,x-api-key + anthropic-version。
 *
 * 不做内网地址拦截:只有管理员能调,且运行时 SDK 本就直连这个地址(本机或内网网关很常见)。
 * 不跟随重定向:跟随会把 Key 带到另一个地址。
 */
export class AnthropicHttpProbe implements ProviderProbe {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async testAnthropic(input: {
    baseUrl: string;
    key: string;
    modelId: string;
  }): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const res = await this.fetchFn(`${input.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": input.key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: input.modelId,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const latencyMs = Date.now() - started;
      const body = (await res.text().catch(() => "")).slice(0, MAX_BODY);
      if (res.status >= 300 && res.status < 400) {
        return {
          ok: false,
          status: res.status,
          latencyMs,
          message: "接入地址返回了重定向,请填写最终地址",
        };
      }
      if (res.ok) {
        const reported = reportedModelOf(body);
        if (reported && reported !== input.modelId) {
          return {
            ok: true,
            status: res.status,
            latencyMs,
            reportedModel: reported,
            message: `连接成功,但上游回报的模型名是「${reported}」,与填写的模型标识「${input.modelId}」不一致。运行用量会按上游回报的名字记,对不上的部分只能按主模型价计费,建议把模型标识改成「${reported}」`,
          };
        }
      }
      return {
        ok: res.ok,
        status: res.status,
        latencyMs,
        message: res.ok ? "连接成功" : summarize(body, input.key) || `HTTP ${res.status}`,
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const timeout = err instanceof Error && err.name === "TimeoutError";
      return {
        ok: false,
        latencyMs,
        message: timeout
          ? `连接超时(${TIMEOUT_MS / 1000} 秒)`
          : summarize(err instanceof Error ? err.message : String(err), input.key) || "连接失败",
      };
    }
  }
}

/** 成功响应里上游回报的模型名(Messages API 的 model 字段);没有返回 undefined */
function reportedModelOf(body: string): string | undefined {
  try {
    const m = (JSON.parse(body) as { model?: unknown }).model;
    return typeof m === "string" && m.length > 0 && m.length <= 200 ? m : undefined;
  } catch {
    return undefined;
  }
}
