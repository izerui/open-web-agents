// 测试用的模型目录视图:四个别名都是可用的文本模型(同一来源),可追加其它条目。
import { MODEL_ALIASES } from "@/lib/shared";
import type { ModelCatalogView, ModelRefInfo } from "../validate-config";

export function catalogView(extra: Record<string, Partial<ModelRefInfo>> = {}): ModelCatalogView {
  const entries = new Map<string, ModelRefInfo>();
  for (const alias of MODEL_ALIASES) {
    entries.set(alias, { name: `模型 ${alias}`, kind: "llm", enabled: true, group: "g1" });
  }
  for (const [id, info] of Object.entries(extra)) {
    entries.set(id, { name: id, kind: "llm", enabled: true, group: "g1", ...info });
  }
  return { resolve: (ref) => entries.get(ref) ?? null };
}
