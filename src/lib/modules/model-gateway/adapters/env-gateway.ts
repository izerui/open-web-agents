import type { ModelGatewayPort, ModelSlots } from "@/lib/modules/model-gateway/ports";

export interface ModelSlotConfig {
  /** 基础/回退模型:各别名槽未单独配置时都回退到它(单模型部署,常见于兼容网关)。空 = 不统一。 */
  base?: string;
  fable?: string;
  opus?: string;
  sonnet?: string;
  haiku?: string;
}

/**
 * 什么都没配时,各别名用的官方模型 id。
 *
 * 【为什么不能回退成别名字面量】曾经 OWA_MODEL 默认是 "sonnet",于是四个槽都是 "sonnet",
 * SDK 照原样把 "sonnet" 当 model id 发给网关(scripts/sdk-probe 实测)—— 官方 API 不认这个 id,
 * 按快速开始只填了 Key 的部署,第一次对话就失败。
 */
export const OFFICIAL_MODEL_IDS: ModelSlots = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5-20251001",
};

/** 别名槽 → 真实 model id。优先级:该槽单独配置 > 统一的 base > 官方模型 id。 */
export class EnvModelGateway implements ModelGatewayPort {
  constructor(private readonly cfg: ModelSlotConfig) {}

  slots(): ModelSlots {
    const pick = (slot: keyof ModelSlots) =>
      this.cfg[slot] || this.cfg.base || OFFICIAL_MODEL_IDS[slot];
    return {
      fable: pick("fable"),
      opus: pick("opus"),
      sonnet: pick("sonnet"),
      haiku: pick("haiku"),
    };
  }
}
