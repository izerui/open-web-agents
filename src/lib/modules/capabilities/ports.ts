import { BrandedError } from "@/lib/shared";
import type { Capability, CapabilityDefinition } from "./domain/catalog";

export class CapabilityConflict extends BrandedError {
  static readonly brand = Symbol.for("owa.error.CapabilityConflict");

  constructor() {
    super("能力配置已变化,请刷新后重试");
  }
}

/** 同一提供者下两个文本模型用了同一个模型标识:计量按模型标识匹配价目,无法区分。 */
export class DuplicateModelId extends BrandedError {
  static readonly brand = Symbol.for("owa.error.DuplicateModelId");

  constructor(modelId: string) {
    super(`同一提供者下已有文本模型使用标识「${modelId}」`);
  }
}

export interface CapabilityVersion extends Capability {
  createdBy: string;
}

export interface CapabilityRepo {
  list(includeDisabled?: boolean): Promise<Capability[]>;

  get(id: string): Promise<Capability | null>;

  /** expectedVersion=null 只允许新建。修改价目与保存版本快照在同一事务中。 */
  save(
    definition: CapabilityDefinition,
    expectedVersion: number | null,
    actorId: string,
  ): Promise<Capability>;

  version(id: string, version: number): Promise<CapabilityVersion | null>;

  /**
   * 迁移用:停用一条旧记录并记下替代它的模型,追加一个版本。不走定义校验 ——
   * 旧版本允许、新规则已不合法的 ID(如 sonnet)按新规则无法保存。已替代过的不重复处理。
   */
  retire(id: string, replacedBy: string, actorId: string): Promise<void>;
}
