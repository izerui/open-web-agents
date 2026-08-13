import type { CredentialChain, ModelAlias, ResolvedCredentials } from "@/lib/shared";

/** 取第一个已定义且非空的值。空串视为未配置(env 缺省常是空串)。 */
function pick(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) if (v !== undefined && v !== "") return v;
  return undefined;
}

/**
 * 四级凭证解析,优先级 request > session > user > platform。
 * baseUrl 与 key 各自独立解析 —— 允许用户只覆盖 key 而沿用平台网关。
 */
export function resolveCredentials(chain: CredentialChain): ResolvedCredentials {
  const baseUrl = pick(
    chain.request?.baseUrl,
    chain.session?.baseUrl,
    chain.user?.baseUrl,
    chain.platform?.baseUrl,
  );
  const key = pick(chain.request?.key, chain.session?.key, chain.user?.key, chain.platform?.key);
  if (!baseUrl) throw new Error("no baseUrl resolved from credential chain");
  if (!key) throw new Error("no key resolved from credential chain");
  return { baseUrl, key };
}

/** 模型别名解析,优先级 request > session > 智能体配置兜底。 */
export function resolveModelAlias(chain: CredentialChain, fallback: ModelAlias): ModelAlias {
  return chain.request?.model ?? chain.session?.model ?? fallback;
}
