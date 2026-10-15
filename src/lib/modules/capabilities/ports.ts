import { BrandedError } from "@/lib/shared";
import type { Capability, CapabilityDefinition } from "./domain/catalog";

export class CapabilityConflict extends BrandedError {
  static readonly brand = Symbol.for("owa.error.CapabilityConflict");

  constructor() {
    super("能力配置已变化,请刷新后重试");
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
}
