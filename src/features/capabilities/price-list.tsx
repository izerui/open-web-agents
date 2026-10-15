"use client";

import { Button } from "@/components/ui/button";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { type Capability, formatCredits } from "@/lib/modules/capabilities/domain/catalog";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

type PublicItem = Pick<Capability, "id" | "name" | "kind" | "rates" | "version"> & {
  available: boolean;
};
const units: Record<string, string> = {
  input_token: "输入 token",
  output_token: "输出 token",
  cache_read_token: "缓存读取 token",
  cache_write_token: "缓存写入 token",
  image: "张图片",
  video_ms: "毫秒视频",
  audio_input_ms: "毫秒输入音频",
  audio_output_ms: "毫秒输出音频",
  character: "字符",
};

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
        <h2 className="text-sm font-medium">平台能力价目</h2>
        <Button
          variant="ghost"
          size="icon"
          title="刷新价目"
          onClick={() => setRefresh((v) => v + 1)}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">当前仅展示价目配置，积分扣款尚未启用。</p>
      {error ? (
        <p aria-live="polite" className="text-sm text-destructive">
          {error}
        </p>
      ) : items === null ? (
        <p className="text-sm text-muted-foreground">载入中…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">管理员尚未发布能力价目。</p>
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.id} className="py-3">
              <p className="text-sm font-medium">
                {item.name}
                <span className="ml-2 text-xs text-muted-foreground">
                  v{item.version} · {item.available ? "已配置" : "待接入"}
                </span>
              </p>
              {item.rates.map((rate) => (
                <p key={rate.meter} className="mt-1 text-xs text-muted-foreground">
                  {formatCredits(rate.microCredits)} 积分 / {rate.units} {units[rate.meter]}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
