"use client";

import { Pencil } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { isAdminView, useMe } from "@/lib/use-me";
import { parseRpmDraft } from "./key-display";

/** 平台默认的调用限流;0 = 不限。 */
export interface PlatformRateLimits {
  perKeyPerMinute: number;
  perAgentPerMinute: number;
}

/** 行内编辑的铅笔按钮(原型 .dk-pen) */
export function PenButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="inline-grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground max-md:size-11"
    >
      <Pencil className="size-[15px]" />
    </button>
  );
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
  const { me } = useMe();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // 普通账号只能把单把 Key 调到平台默认以内;管理员不受此限(与服务端 validateKeyRateLimit 一致)
  const max = isAdminView(me) ? 0 : platform;

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
      setError(`调整失败:${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        {value !== undefined ? (
          <>
            <b className="font-semibold">{value}</b>
            <span className="text-xs text-muted-foreground">次/分</span>
          </>
        ) : platform > 0 ? (
          <>
            <span>{platform}</span>
            <span className="text-xs text-muted-foreground">次/分，默认</span>
          </>
        ) : (
          <span className="text-muted-foreground">不限，默认</span>
        )}
        <PenButton
          label="修改每分钟上限"
          onClick={() => {
            setDraft(String(value ?? (platform > 0 ? platform : "")));
            setError("");
            setEditing(true);
          }}
        />
      </span>
    );
  }

  return (
    <form
      noValidate
      className="flex min-w-[200px] flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const r = parseRpmDraft(draft, max);
        if (!r.ok) return setError(r.error);
        void save(r.value);
      }}
    >
      <span className="flex items-center gap-1.5">
        <Input
          inputMode="numeric"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError("");
          }}
          aria-invalid={Boolean(error) || undefined}
          className="h-8 w-[110px]"
          aria-label="每分钟上限"
          autoFocus
        />
        <span className="text-xs text-muted-foreground">次/分钟</span>
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <Button type="submit" size="xs" disabled={saving}>
          保存
        </Button>
        {value !== undefined && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={saving}
            onClick={() => void save(null)}
          >
            恢复默认
          </Button>
        )}
        <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(false)}>
          取消
        </Button>
      </span>
      {error && (
        <span aria-live="polite" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </form>
  );
}
