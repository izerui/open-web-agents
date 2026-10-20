// 模型提供者:按模型类型配置接入地址。凭证不在这里 —— 只在仓库里以密文存放。
import { CAPABILITY_KINDS, type CapabilityKind } from "@/lib/modules/capabilities/domain/catalog";
import { MODEL_ALIASES, type ModelAlias } from "@/lib/shared";

/** 智能体运行引擎只支持 Anthropic 协议;其他类型暂未接入运行时,协议只作记录。 */
export const ENDPOINT_PROTOCOLS: Record<CapabilityKind, readonly string[]> = {
  llm: ["anthropic"],
  image: ["openai-compatible", "custom"],
  video: ["openai-compatible", "custom"],
  speech: ["openai-compatible", "custom"],
  transcription: ["openai-compatible", "custom"],
};

export interface ProviderEndpoint {
  protocol: string;
  baseUrl: string;
}

export type ProviderEndpoints = Partial<Record<CapabilityKind, ProviderEndpoint>>;

export interface ProviderDefinition {
  id: string;
  name: string;
  enabled: boolean;
  endpoints: ProviderEndpoints;
}

export interface Provider extends ProviderDefinition {
  hasKey: boolean;
  /** 掩码,如 ****abcd */
  keyHint: string | null;
  version: number;
  updatedAt: number;
}

export const DEFAULT_PROVIDER_ID = "platform-default";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 只做字面校验:协议、内嵌凭证、查询串。末尾斜杠去掉,与 SDK 拼接 /v1/messages 一致。 */
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 500) {
    throw new Error("接入地址须为 1~500 个字符");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("接入地址格式不正确");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("接入地址只支持 http / https");
  }
  if (url.username || url.password) throw new Error("接入地址不能包含账号或密码,请填在 API Key 中");
  if (url.search || url.hash) throw new Error("接入地址不能包含查询参数或锚点");
  return url.toString().replace(/\/+$/, "");
}

export function validateProvider(raw: unknown): ProviderDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("提供者定义必须是对象");
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || !SLUG.test(v.id)) {
    throw new Error("ID 须为最多 64 个小写字母、数字、下划线或连字符");
  }
  if (typeof v.name !== "string" || !v.name.trim() || v.name.trim().length > 120) {
    throw new Error("名称须为 1~120 个字符");
  }
  if (typeof v.enabled !== "boolean") throw new Error("启用标志必须是布尔值");
  const rawEndpoints = v.endpoints ?? {};
  if (typeof rawEndpoints !== "object" || Array.isArray(rawEndpoints)) {
    throw new Error("接入地址须按模型类型配置");
  }
  const endpoints: ProviderEndpoints = {};
  for (const [kind, ep] of Object.entries(rawEndpoints as Record<string, unknown>)) {
    if (!CAPABILITY_KINDS.includes(kind as CapabilityKind)) throw new Error(`未知模型类型:${kind}`);
    if (ep === null || ep === undefined) continue;
    if (typeof ep !== "object" || Array.isArray(ep)) throw new Error("接入地址格式不正确");
    const e = ep as Record<string, unknown>;
    const allowed = ENDPOINT_PROTOCOLS[kind as CapabilityKind];
    if (typeof e.protocol !== "string" || !allowed.includes(e.protocol)) {
      throw new Error(`${kind} 只支持协议:${allowed.join(" / ")}`);
    }
    endpoints[kind as CapabilityKind] = {
      protocol: e.protocol,
      baseUrl: normalizeBaseUrl(e.baseUrl),
    };
  }
  return { id: v.id, name: v.name.trim(), enabled: v.enabled, endpoints };
}

export type AliasTargets = Record<ModelAlias, string>;

export interface ModelAliasMap extends AliasTargets {
  providerId: string;
}

export interface ModelAliases extends ModelAliasMap {
  version: number;
  updatedAt: number;
}

export function validateAliasMap(raw: unknown): ModelAliasMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("别名映射必须是对象");
  const v = raw as Record<string, unknown>;
  if (typeof v.providerId !== "string" || !SLUG.test(v.providerId)) {
    throw new Error("须选择提供者");
  }
  const targets = {} as AliasTargets;
  for (const alias of MODEL_ALIASES) {
    const target = v[alias];
    if (typeof target !== "string" || !SLUG.test(target)) throw new Error(`须为 ${alias} 选择模型`);
    targets[alias] = target;
  }
  return { providerId: v.providerId, ...targets };
}
