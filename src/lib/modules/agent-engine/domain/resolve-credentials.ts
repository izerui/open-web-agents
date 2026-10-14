import type { CredentialChain, ModelAlias, ResolvedCredentials } from "@/lib/shared";

/** 全平台统一凭证。历史载荷中的用户 Key 与网关覆盖不再参与解析。 */
export function resolveCredentials(chain: CredentialChain): ResolvedCredentials {
  const baseUrl = chain.platform?.baseUrl?.trim();
  const key = chain.platform?.key?.trim();
  if (!baseUrl) throw new Error("平台尚未配置模型 Base URL,请联系管理员");
  if (!key) throw new Error("平台尚未配置模型 API Key,请联系管理员");
  return { baseUrl, key };
}

/** 调用方只能选择平台支持的模型别名。 */
export function resolveModelAlias(chain: CredentialChain, fallback: ModelAlias): ModelAlias {
  return chain.request?.model ?? fallback;
}
