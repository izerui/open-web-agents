import type { ModelAlias } from "@/lib/shared";

/**
 * 别名槽 → 真实 modelId 的映射表。
 *
 * 平台对外只暴露角色化别名(opus=最强/sonnet=主力/haiku=轻量),真实模型由部署方配置。
 * 这层让平台能挂在任意 Anthropic 兼容网关上(DashScope/GLM/自建),换模型不动业务代码。
 */
export type ModelSlots = Record<ModelAlias, string>;

export interface ModelGatewayPort {
  /** 解析出注入给 agent 子进程的四个别名槽。 */
  slots(): ModelSlots;
}
