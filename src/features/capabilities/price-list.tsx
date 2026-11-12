"use client";

import { LoadError } from "@/components/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KIND_LABEL, KIND_ORDER, creditsText, perStandard } from "@/features/models/model-shared";
import { EmptyState, tb } from "@/features/settings/space-page";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { Capability, CapabilityKind } from "@/lib/modules/capabilities/domain/catalog";
import { STANDARD_METERS } from "@/lib/modules/capabilities/domain/pricing";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

type PublicItem = Pick<Capability, "id" | "name" | "kind" | "rates" | "version"> & {
  available: boolean;
  acceptsImages?: boolean;
};

type Aliases = Record<"fable" | "opus" | "sonnet" | "haiku", string | undefined> | null;

/** 每种类型的计价单位(价目表头) */
const UNIT_OF: Record<CapabilityKind, string> = {
  llm: "积分 / 百万 tokens",
  image: "积分 / 张",
  video: "积分 / 秒",
  speech: "积分 / 万字符",
  transcription: "积分 / 分钟",
};

/**
 * 用户看到的模型售价:按类型分页签,按标准单位展示,不含成本、加价与提供者。
 * configured = 平台是否配好了文本模型提供者;没配好时价目暂不可用。
 */
export function PriceList({ configured = true }: { configured?: boolean }) {
  const [items, setItems] = useState<PublicItem[] | null>(null);
  const [aliases, setAliases] = useState<Aliases>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [kind, setKind] = useState<CapabilityKind>("llm");
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the explicit reload trigger
  useEffect(() => {
    let active = true;
    setError("");
    void fetchJson<{ capabilities: PublicItem[]; aliases?: Aliases }>("/api/capabilities").then(
      (data) => {
        if (!active) return;
        setItems(data.capabilities);
        setAliases(data.aliases ?? null);
      },
      (err) => {
        if (active) setError(errorText(err));
      },
    );
    return () => {
      active = false;
    };
  }, [refresh]);

  const list = (items ?? []).filter((i) => i.kind === kind);
  const meters = STANDARD_METERS[kind];
  const aliasOf = (id: string) =>
    aliases
      ? (Object.entries(aliases) as [string, string | undefined][])
          .filter(([, v]) => v === id)
          .map(([k]) => k)
      : [];

  return (
    <>
      <div className="mb-3 flex items-center gap-2 overflow-x-auto border-b border-border">
        <fieldset aria-label="模型类型" className="flex">
          {KIND_ORDER.map((k) => {
            const all = (items ?? []).filter((i) => i.kind === k);
            const on = all.filter((i) => i.available).length;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  "-mb-px h-11 shrink-0 border-b-2 border-transparent px-3.5 text-sm whitespace-nowrap text-muted-foreground",
                  kind === k && "border-foreground font-semibold text-foreground",
                )}
              >
                {KIND_LABEL[k]}{" "}
                {items && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {all.length ? `${on}/${all.length}` : "0"}
                  </span>
                )}
              </button>
            );
          })}
        </fieldset>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto shrink-0"
          title="刷新价格"
          aria-label="刷新价格"
          onClick={() => setRefresh((v) => v + 1)}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      <section
        aria-label={`${KIND_LABEL[kind]}价目`}
        className="rounded-2xl border border-border bg-card"
      >
        {error ? (
          <div className="p-2">
            <LoadError
              what="模型价格"
              message={error}
              onRetryAction={() => setRefresh((v) => v + 1)}
            />
          </div>
        ) : items === null ? (
          <p className="px-[22px] py-5 text-sm text-muted-foreground">载入中…</p>
        ) : !configured && kind === "llm" && list.length === 0 ? (
          <EmptyState title="价目暂不可用">
            平台还没配置模型提供者，配置后这里会显示每个模型的价格。
          </EmptyState>
        ) : list.length === 0 ? (
          <EmptyState title={`还没有${KIND_LABEL[kind]}模型`}>
            管理员还没有为「{KIND_LABEL[kind]}」添加模型。
          </EmptyState>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2.5 px-[22px] pt-4 pb-1.5 max-md:px-4">
              <b>{KIND_LABEL[kind]}</b>
              <span className="text-xs text-muted-foreground">单位：{UNIT_OF[kind]}</span>
              {kind !== "llm" && (
                <Badge variant="warning" className="ml-auto">
                  {KIND_LABEL[kind]}暂未接入运行时，智能体还不能调用
                </Badge>
              )}
            </div>
            <div className={tb.wrap}>
              <table className={cn(tb.table, "min-w-[640px]")}>
                <caption className="sr-only">{KIND_LABEL[kind]}模型价目</caption>
                <thead>
                  <tr>
                    <th scope="col" className={cn(tb.th, tb.first)}>
                      模型
                    </th>
                    {meters.map((m) => (
                      <th scope="col" key={m.meter} className={cn(tb.th, tb.right)}>
                        {m.item || `每${m.unit}`}
                      </th>
                    ))}
                    {kind === "llm" && (
                      <th scope="col" className={tb.th}>
                        说明
                      </th>
                    )}
                    <th scope="col" className={cn(tb.th, tb.last)}>
                      状态
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((item) => {
                    const alias = aliasOf(item.id);
                    const notes = [
                      alias.length ? `默认「${alias.join("、")}」` : "",
                      item.acceptsImages ? "支持图片输入" : "仅文本",
                    ].filter(Boolean);
                    return (
                      <tr key={item.id} className={cn(!item.available && "text-muted-foreground")}>
                        <td className={cn(tb.td, tb.first, item.available && "font-semibold")}>
                          {item.name}
                        </td>
                        {meters.map((m) => {
                          const price = perStandard(item.rates, m.meter, m.units);
                          return (
                            <td key={m.meter} className={cn(tb.td, tb.num, tb.right, "font-mono")}>
                              {price ? (
                                creditsText(price.micro)
                              ) : (
                                <span className="font-sans text-muted-foreground">不支持</span>
                              )}
                            </td>
                          );
                        })}
                        {kind === "llm" && (
                          <td className={cn(tb.td, "text-xs")}>{notes.join("，")}</td>
                        )}
                        <td className={cn(tb.td, tb.last)}>
                          {item.available ? (
                            <Badge variant="success">可用</Badge>
                          ) : (
                            <Badge variant="warning">
                              {kind === "llm" ? "暂不可用" : "暂未开放调用"}
                            </Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {kind === "llm" && (
              <p className="px-[22px] pt-3 pb-4 text-xs text-muted-foreground max-md:px-4">
                按实际用量与使用时的价格计算。运行开始时会按模型先冻结一部分积分，结束后按实际用量多退少补。
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}
