import { NativeSelect as Select } from "@/components/ui/native-select";
import { creditsText, perStandard } from "@/features/models/model-shared";
import { fetchJson } from "@/lib/fetch-json";
import type { CreditRate } from "@/lib/modules/capabilities/domain/catalog";
import { isModelAlias } from "@/lib/shared";
import { useEffect, useState } from "react";

export interface PublicModel {
  id: string;
  name: string;
  kind: string;
  rates: CreditRate[];
  available: boolean;
  /** 不透明的来源分组;子代理只能选与主模型同组的模型 */
  group: string;
}

export interface ModelCatalog {
  models: PublicModel[];
  aliases: Record<string, string> | null;
}

/**
 * 页面内共享的模型目录:多处(市场列表每张卡片)共用一次请求,用到的组件都订阅更新。
 * 价格会被管理员改:窗口重新获得焦点时、发起新一轮运行前(refreshModelCatalog)重新拉取,
 * 已打开的页面不必整页刷新也能看到新售价。
 */
const STALE_MS = 30_000;
let current: ModelCatalog | null = null;
let fetchedAt = 0;
let inflight: Promise<ModelCatalog> | null = null;
const listeners = new Set<(c: ModelCatalog) => void>();

function fetchCatalog(): Promise<ModelCatalog> {
  inflight ??= fetchJson<{
    capabilities: PublicModel[];
    aliases: Record<string, string> | null;
  }>("/api/capabilities")
    .then(
      (r) => {
        current = {
          models: r.capabilities.filter((m) => m.kind === "llm"),
          aliases: r.aliases,
        };
        fetchedAt = Date.now();
        return current;
      },
      // 拉不到时保留上一份;一份都没有就给空目录,保存时由服务端兜底校验
      () => current ?? { models: [], aliases: null },
    )
    .then((c) => {
      for (const fn of listeners) fn(c);
      return c;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 强制重新拉取(发起运行前等);返回最新目录。 */
export function refreshModelCatalog(): Promise<ModelCatalog> {
  return fetchCatalog();
}

let focusBound = false;
function bindFocusRefresh() {
  if (focusBound || typeof window === "undefined") return;
  focusBound = true;
  window.addEventListener("focus", () => {
    if (listeners.size > 0) void fetchCatalog();
  });
}

export function useModelCatalog(): ModelCatalog | null {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(current);
  useEffect(() => {
    listeners.add(setCatalog);
    bindFocusRefresh();
    if (current) setCatalog(current);
    if (!current || Date.now() - fetchedAt > STALE_MS) void fetchCatalog();
    return () => {
      listeners.delete(setCatalog);
    };
  }, []);
  return catalog;
}

/** 别名或模型 id → 目录里的模型(停用或不存在返回 undefined) */
export function modelOf(catalog: ModelCatalog | null, ref: string): PublicModel | undefined {
  if (!catalog || !ref) return undefined;
  const id = isModelAlias(ref) ? catalog.aliases?.[ref] : ref;
  return catalog.models.find((m) => m.id === id);
}

export function priceHint(m: PublicModel): string {
  const input = perStandard(m.rates, "input_token", "1000000");
  const output = perStandard(m.rates, "output_token", "1000000");
  if (!input || !output) return m.name;
  return `${m.name} · 输入 ${creditsText(input.micro)} / 输出 ${creditsText(output.micro)} 积分/百万token`;
}

export function ModelSelect({
  catalog,
  value,
  onChange,
  group,
  inheritLabel,
  ariaLabel,
  className,
}: {
  catalog: ModelCatalog | null;
  value: string;
  onChange: (ref: string) => void;
  /** 只列出该来源分组的模型(子代理) */
  group?: string;
  /** 给了就加一个"跟随主模型"的空选项 */
  inheritLabel?: string;
  ariaLabel: string;
  className?: string;
}) {
  const options = (catalog?.models ?? []).filter(
    (m) => m.available && (group === undefined || m.group === group),
  );
  const current = modelOf(catalog, value);
  const legacyAlias = isModelAlias(value);
  // 当前值不在可选列表里(停用、不可用或跨来源):保留它,但标出来,让作者改选
  const stale = !!value && catalog !== null && !legacyAlias && !options.some((m) => m.id === value);
  const aliasStale = legacyAlias && catalog !== null && (!current || !current.available);

  return (
    <div className={className}>
      <Select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
        {inheritLabel !== undefined && <option value="">{inheritLabel}</option>}
        {legacyAlias && (
          <option value={value}>
            跟随平台默认({value}
            {current ? ` → ${current.name}` : ""})
          </option>
        )}
        {stale && <option value={value}>{current?.name ?? "已停用的模型"}(请重新选择)</option>}
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {priceHint(m)}
          </option>
        ))}
      </Select>
      {(stale || aliasStale) && (
        <p aria-live="assertive" className="mt-1 text-xs text-destructive">
          {group !== undefined && current && current.group !== group
            ? "该模型不能与主模型同时使用,请重新选择"
            : "当前模型已停用或不可用,请重新选择"}
        </p>
      )}
    </div>
  );
}
