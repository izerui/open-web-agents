import type { CredentialChain, ModelAlias, ResolvedCredentials } from "@/lib/shared";

/** 取第一个已定义且非空的值。空串视为未配置(env 缺省常是空串)。 */
function pick(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) if (v !== undefined && v !== "") return v;
  return undefined;
}

/**
 * 四级凭证解析,优先级 request > session > user > platform。
 *
 * 【同层绑定】baseUrl 取最高优先的那一层;key 必须来自【同一层或更高优先的层】。
 * 允许"只覆盖 key、沿用平台网关"(key 层比 baseUrl 层高),
 * 禁止"自定义 baseUrl、借用下层的 key"。
 *
 * 曾经两者各自独立回退:调用方只给自己的 baseUrl、不给 key,链条就解析成
 * "攻击者的地址 + 平台 key",agent 子进程随即把平台 key 放进请求头发了过去。
 * 用户设置页的 baseUrl、invoke 的 override 都能触发。
 */
export function resolveCredentials(chain: CredentialChain): ResolvedCredentials {
  const layers = [chain.request, chain.session, chain.user, chain.platform];
  const baseIdx = layers.findIndex((l) => pick(l?.baseUrl) !== undefined);
  const keyIdx = layers.findIndex((l) => pick(l?.key) !== undefined);
  // 这两句会原样显示在界面与 /result 里 —— 要让人看得懂该去配什么
  if (baseIdx < 0) {
    throw new Error(
      "没有可用的模型 Base URL(baseUrl):平台未配置默认网关,账号与本次请求也都没有提供",
    );
  }
  if (keyIdx < 0) {
    throw new Error(
      "没有可用的模型 API Key:平台未配置默认 key,账号也没有自带 key —— 请在「模型凭证」里配置,或联系管理员",
    );
  }
  if (keyIdx > baseIdx) {
    throw new Error(
      "自定义了 baseUrl 却没有在同一层提供 key —— 拒绝把下层(含平台)的 key 发往自定义的 baseUrl",
    );
  }
  return {
    baseUrl: pick(layers[baseIdx]?.baseUrl) as string,
    key: pick(layers[keyIdx]?.key) as string,
  };
}

/** 模型别名解析,优先级 request > session > 智能体配置兜底。 */
export function resolveModelAlias(chain: CredentialChain, fallback: ModelAlias): ModelAlias {
  return chain.request?.model ?? chain.session?.model ?? fallback;
}
