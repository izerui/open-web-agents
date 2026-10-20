import { modelOf, priceHint, useModelCatalog } from "@/features/builder/model-select";

/**
 * 智能体所用模型的名称与售价(积分 / 百万 token)。只用公开目录:不含提供者与上游模型标识。
 * 模型停用或尚不可用时如实提示,不显示一个用不了的价格。
 */
export function ModelPrice({ model, className }: { model?: string; className?: string }) {
  const catalog = useModelCatalog();
  if (!model || !catalog) return null;
  const m = modelOf(catalog, model);
  return (
    <span className={className} data-testid="agent-model-price">
      {m?.available ? priceHint(m) : "模型暂不可用"}
    </span>
  );
}
