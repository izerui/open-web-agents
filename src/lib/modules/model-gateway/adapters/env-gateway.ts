import type { ModelGatewayPort, ModelSlots } from "@/lib/modules/model-gateway/ports";

export interface ModelSlotConfig {
  /** 基础/回退模型:各别名槽未单独配置时都回退到它。 */
  base: string;
  fable?: string;
  opus?: string;
  sonnet?: string;
  haiku?: string;
}

/** 从配置解析别名槽;未单独配置的槽回退到 base(统一成单模型部署)。 */
export class EnvModelGateway implements ModelGatewayPort {
  constructor(private readonly cfg: ModelSlotConfig) {}

  slots(): ModelSlots {
    const { base } = this.cfg;
    return {
      fable: this.cfg.fable || base,
      opus: this.cfg.opus || base,
      sonnet: this.cfg.sonnet || base,
      haiku: this.cfg.haiku || base,
    };
  }
}
