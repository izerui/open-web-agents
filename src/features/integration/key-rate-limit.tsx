"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorText, fetchJson } from "@/lib/fetch-json";

/** 平台默认的调用限流;0 = 不限。 */
export interface PlatformRateLimits {
  perKeyPerMinute: number;
  perAgentPerMinute: number;
}

export function describeKeyLimit(own: number | undefined, platform: number): string {
  if (own !== undefined) return `每分钟 ${own} 次`;
  return platform > 0 ? `每分钟 ${platform} 次(默认)` : "不限(默认)";
}

/** Key 列表里的一行限额:显示实际上限,可以就地调整或恢复默认。 */
export function KeyRateLimit({
  keyId,
  value,
  platform,
  onSaved,
}: {
  keyId: string;
  value?: number;
  platform: number;
  onSaved: () => unknown;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(next: number | null) {
    setSaving(true);
    try {
      await fetchJson(`/api/keys?id=${encodeURIComponent(keyId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rateLimitPerMinute: next }),
      });
      toast.success(next === null ? "已恢复平台默认" : `已设为每分钟 ${next} 次`);
      setEditing(false);
      await onSaved();
    } catch (e) {
      toast.error(`调整失败:${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="h-8 shrink-0 rounded px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="调整这把 Key 每分钟可发起的新调用次数"
        onClick={() => {
          setDraft(value === undefined ? "" : String(value));
          setEditing(true);
        }}
      >
        {describeKeyLimit(value, platform)}
      </button>
    );
  }

  const n = Number(draft);
  const valid = Number.isInteger(n) && n >= 1;
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Input
        type="number"
        min={1}
        max={platform > 0 ? platform : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="h-8 w-20 text-xs"
        aria-label="每分钟上限"
        autoFocus
      />
      <Button size="sm" className="h-8" disabled={!valid || saving} onClick={() => void save(n)}>
        保存
      </Button>
      {value !== undefined && (
        <Button
          size="sm"
          variant="ghost"
          className="h-8"
          disabled={saving}
          onClick={() => void save(null)}
        >
          恢复默认
        </Button>
      )}
      <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditing(false)}>
        取消
      </Button>
    </span>
  );
}
