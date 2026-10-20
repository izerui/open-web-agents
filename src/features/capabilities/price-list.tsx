"use client";

import { Button } from "@/components/ui/button";
import { KIND_LABEL, KIND_ORDER, creditsText, perStandard } from "@/features/models/model-shared";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { Capability } from "@/lib/modules/capabilities/domain/catalog";
import { STANDARD_METERS } from "@/lib/modules/capabilities/domain/pricing";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

type PublicItem = Pick<Capability, "id" | "name" | "kind" | "rates" | "version"> & {
  available: boolean;
};

/** 用户看到的模型售价:按类型分组、按标准单位展示,不含成本与加价。 */
export function PriceList() {
  const [items, setItems] = useState<PublicItem[] | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the explicit reload trigger
  useEffect(() => {
    let active = true;
    setError("");
    void fetchJson<{ capabilities: PublicItem[] }>("/api/capabilities").then(
      (data) => {
        if (active) setItems(data.capabilities);
      },
      (err) => {
        if (active) setError(errorText(err));
      },
    );
    return () => {
      active = false;
    };
  }, [refresh]);
  return (
    <section className="mt-6 border-t pt-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">模型价格</h2>
        <Button
          variant="ghost"
          size="icon"
          title="刷新价格"
          onClick={() => setRefresh((v) => v + 1)}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        1 元 = 100 积分。按实际用量与使用时的价格计算,积分扣款尚未启用。
      </p>
      {error ? (
        <p aria-live="polite" className="text-sm text-destructive">
          {error}
        </p>
      ) : items === null ? (
        <p className="text-sm text-muted-foreground">载入中…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">管理员尚未发布模型价格。</p>
      ) : (
        <div className="space-y-6">
          {KIND_ORDER.filter((k) => items.some((i) => i.kind === k)).map((kind) => (
            <div key={kind}>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">{KIND_LABEL[kind]}</h3>
              <ul className="divide-y rounded-md border">
                {items
                  .filter((i) => i.kind === kind)
                  .map((item) => (
                    <li key={item.id} className="px-3 py-3">
                      <p className="text-sm font-medium">
                        {item.name}
                        {!item.available && (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            {kind === "llm" ? "暂不可用" : "暂未开放调用"}
                          </span>
                        )}
                      </p>
                      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {STANDARD_METERS[kind].map((m) => {
                          const price = perStandard(item.rates, m.meter, m.units);
                          return price ? (
                            <span key={m.meter}>
                              {m.item && `${m.item} `}
                              <span className="font-mono text-foreground">
                                {creditsText(price.micro)}
                              </span>{" "}
                              积分 / {m.unit}
                            </span>
                          ) : null;
                        })}
                      </p>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
