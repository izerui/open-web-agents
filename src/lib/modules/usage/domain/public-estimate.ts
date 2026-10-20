// 对外的积分估算:按模型目录(运行锁定的价目版本)把上游模型标识换成公开模型 id 与显示名称。
// 原始估算(含上游标识)只留在库里,给结算与对账用。纯函数。
import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import type { RunCreditEstimate } from "./estimate";

export interface PublicModelUsage {
  /** 模型目录里的公开 id(构建器与价目页用的那个);对应不上时为 null */
  model: string | null;
  name: string;
  /** 计价用的价目版本 */
  version: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  microCredits: string | null;
  unpriced: boolean;
}

export interface PublicCreditEstimate {
  totalMicroCredits: string;
  complete: boolean;
  models: PublicModelUsage[];
}

type CatalogEntry = Pick<Capability, "id" | "name" | "modelId" | "version" | "kind" | "providerId">;

/**
 * catalog 应当是运行锁定的价目版本(只含本次运行所属提供者);旧运行没有锁定版本时传当前目录,
 * 此时给 providerId 也只是缩小范围。同一上游标识对应多个模型、或对应不上,一律不给 id。
 */
export function toPublicEstimate(
  est: RunCreditEstimate,
  catalog: readonly CatalogEntry[],
  providerId?: string,
): PublicCreditEstimate {
  return {
    totalMicroCredits: est.totalMicroCredits,
    complete: est.complete,
    models: est.models.map((m) => {
      let matches = catalog.filter((c) => c.kind === "llm" && c.modelId === m.modelId);
      if (providerId && matches.length > 1) {
        matches = matches.filter((c) => c.providerId === providerId);
      }
      const hit = matches.length === 1 ? matches[0] : undefined;
      return {
        model: hit?.id ?? null,
        name: hit?.name ?? "未识别的模型",
        version: hit?.version ?? null,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        cacheReadTokens: m.cacheReadTokens,
        cacheWriteTokens: m.cacheWriteTokens,
        microCredits: m.microCredits,
        unpriced: m.unpriced,
      };
    }),
  };
}
