import { BrandedError, type ModelAlias } from "@/lib/shared";
import type { ModelAliasMap, ModelAliases, Provider, ProviderDefinition } from "./domain/provider";

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

export class ProviderConflict extends BrandedError {
  static readonly brand = Symbol.for("owa.error.ProviderConflict");
  constructor(message = "提供者配置已变化,请刷新后重试") {
    super(message);
  }
}

export interface ProviderRepo {
  list(): Promise<Provider[]>;
  get(id: string): Promise<Provider | null>;
  /** expectedVersion=null 只允许新建;名称重复同样视为冲突。不改动凭证。 */
  save(
    definition: ProviderDefinition,
    expectedVersion: number | null,
    actorId: string,
  ): Promise<Provider>;
  /** 只替换凭证密文与掩码,不改版本号:替换 Key 不应让别人正在编辑的表单冲突。 */
  setKey(id: string, keyEnc: string, keyHint: string, actorId: string): Promise<void>;
  /** 凭证密文;只给运行时解析与测试连接用。 */
  keyEnc(id: string): Promise<string | null>;
}

export interface ModelAliasRepo {
  get(): Promise<ModelAliases | null>;
  save(map: ModelAliasMap, expectedVersion: number | null, actorId: string): Promise<ModelAliases>;
}

/** 一次性初始化的完成标记。只在全部步骤成功后写入,中途失败下次启动会重做。 */
export interface BootstrapMarker {
  isDone(key: string): Promise<boolean>;
  markDone(key: string): Promise<void>;
}

export interface ProbeResult {
  ok: boolean;
  /** 上游 HTTP 状态码;连不上时没有 */
  status?: number;
  latencyMs: number;
  /** 截断、去除凭证后的说明 */
  message: string;
}

/** 测试文本接入地址:用给定模型发一条最小请求。 */
export interface ProviderProbe {
  testAnthropic(input: { baseUrl: string; key: string; modelId: string }): Promise<ProbeResult>;
}
