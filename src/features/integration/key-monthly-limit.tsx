"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";
import { formatCredits, parseCredits } from "@/lib/modules/capabilities/domain/catalog";
import { cn } from "@/lib/utils";
import { monthlyShare } from "./key-display";
import { PenButton } from "./key-rate-limit";

/**
 * Key 列表里的本月积分上限:显示本月已用 / 上限(带进度条),可就地调整或取消。
 * 每个对接系统用自己的 Key,各自限额;余额仍由账号共用。
 */
export function KeyMonthlyLimit({
  keyId,
  limitMicro,
  usedMicro,
  onSaved,
}: {
  keyId: string;
  limitMicro?: string;
  usedMicro: string;
  onSaved: () => unknown;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(next: string | null) {
    setSaving(true);
    try {
      await fetchJson(`/api/keys?id=${encodeURIComponent(keyId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyLimitCredits: next }),
      });
      if (next === null) toast.success("这把 Key 本月不再单独限额");
      else if (BigInt(parseCredits(next)) <= BigInt(usedMicro || "0"))
        toast.warning("已保存。本月已用已达上限,这把 Key 本月的新调用会被拒绝");
      else toast.success(`月度上限已设为 ${next} 积分`);
      setEditing(false);
      await onSaved();
    } catch (e) {
      setError(`调整失败:${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    const share = monthlyShare(usedMicro, limitMicro);
    return (
      <span className="inline-flex items-start gap-1">
        <span className="whitespace-nowrap">
          <span>
            <b className="font-semibold tabular-nums">{creditsAmount(usedMicro)}</b>
            <span className="text-muted-foreground">
              {" "}
              / {limitMicro === undefined ? "不限额" : creditsAmount(limitMicro)}
            </span>
          </span>
          {share && (
            <span
              className="mt-1 block h-[5px] w-[120px] overflow-hidden rounded-full bg-[#ECEAE3]"
              title={`本月已用 ${share.pct}%`}
            >
              <span
                className={cn("block h-full", share.high ? "bg-warning" : "bg-success")}
                style={{ width: `${share.pct}%` }}
              />
            </span>
          )}
        </span>
        <PenButton
          label="修改月度积分上限"
          onClick={() => {
            setDraft(limitMicro === undefined ? "" : formatCredits(limitMicro));
            setError("");
            setEditing(true);
          }}
        />
      </span>
    );
  }

  return (
    <form
      className="flex min-w-[200px] flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const text = draft.trim();
        // 留空 = 不单独限额
        if (!text) return void save(null);
        try {
          if (BigInt(parseCredits(text)) <= 0n) throw new Error();
        } catch {
          return setError("填正数,留空表示不限额");
        }
        void save(text);
      }}
    >
      <span className="flex items-center gap-1.5">
        <Input
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-8 w-[110px]"
          aria-label="本月积分上限"
          placeholder="不限额"
          autoFocus
        />
        <span className="text-xs text-muted-foreground">积分/月</span>
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <Button type="submit" size="xs" disabled={saving}>
          保存
        </Button>
        {limitMicro !== undefined && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={saving}
            onClick={() => void save(null)}
          >
            设为不限额
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
