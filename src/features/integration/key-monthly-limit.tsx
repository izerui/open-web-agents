"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";
import { formatCredits, parseCredits } from "@/lib/modules/capabilities/domain/catalog";

/**
 * Key 列表里的本月积分上限:显示本月已用 / 上限,可就地调整或取消。
 * 每个对接系统用自己的 Key,各自限额;余额仍由账号共用。
 */
export function KeyMonthlyLimit({
  keyId,
  limitMicro,
  usedMicro,
  trial,
  onSaved,
}: {
  keyId: string;
  limitMicro?: string;
  usedMicro: string;
  trial: boolean;
  onSaved: () => unknown;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(next: string | null) {
    setSaving(true);
    try {
      await fetchJson(`/api/keys?id=${encodeURIComponent(keyId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyLimitCredits: next }),
      });
      toast.success(next === null ? "已取消这把 Key 的月度上限" : `月度上限已设为 ${next} 积分`);
      setEditing(false);
      await onSaved();
    } catch (e) {
      toast.error(`调整失败:${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  }

  const used = `本月${trial ? "预计" : ""} ${creditsAmount(usedMicro)}`;
  if (!editing) {
    return (
      <button
        type="button"
        className="h-8 shrink-0 rounded px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="调整这把 Key 每月最多可用的积分"
        onClick={() => {
          setDraft(limitMicro === undefined ? "" : formatCredits(limitMicro));
          setEditing(true);
        }}
      >
        {limitMicro === undefined
          ? `${used} 积分 · 不单独限额`
          : `${used} / ${creditsAmount(limitMicro)} 积分`}
      </button>
    );
  }

  let valid = false;
  try {
    parseCredits(draft.trim());
    valid = true;
  } catch {}
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Input
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="h-8 w-24 text-xs"
        aria-label="本月积分上限"
        placeholder="积分"
        autoFocus
      />
      <Button
        size="sm"
        className="h-8"
        disabled={!valid || saving}
        onClick={() => void save(draft.trim())}
      >
        保存
      </Button>
      {limitMicro !== undefined && (
        <Button
          size="sm"
          variant="ghost"
          className="h-8"
          disabled={saving}
          onClick={() => void save(null)}
        >
          不限额
        </Button>
      )}
      <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditing(false)}>
        取消
      </Button>
    </span>
  );
}
