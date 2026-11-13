"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SpacePage } from "@/features/settings/space-page";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { isAdminView, useMe } from "@/lib/use-me";
import { useState } from "react";
import { toast } from "sonner";

/** 账号安全:修改登录密码。管理员建号或重置后给的是一次性密码,用户应在这里改掉。 */
export function AccountSecurityView() {
  const { me } = useMe();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 提交时没过校验的那一栏,红字写在它下面 */
  const [fieldErr, setFieldErr] = useState<{
    field: "current" | "next" | "confirm";
    text: string;
  } | null>(null);
  const mismatch = confirm.length > 0 && confirm !== next;
  const tooShort = next.length > 0 && next.length < 8;
  const currentErr = fieldErr?.field === "current" ? fieldErr.text : "";
  const nextErr = tooShort ? "至少 8 位" : fieldErr?.field === "next" ? fieldErr.text : "";
  const confirmErr = mismatch
    ? "两次输入的密码不一致"
    : fieldErr?.field === "confirm"
      ? fieldErr.text
      : "";

  async function submit() {
    if (busy) return;
    setError("");
    if (!current) return setFieldErr({ field: "current", text: "请输入当前密码" });
    if (next.length < 8) return setFieldErr({ field: "next", text: "新密码至少 8 位" });
    if (next !== confirm) return setFieldErr({ field: "confirm", text: "两次输入的密码不一致" });
    setFieldErr(null);
    setBusy(true);
    try {
      await fetchJson("/api/me/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current, next }),
      });
      toast.success("密码已修改");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (e) {
      setError(`修改失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const who = me?.user
    ? `${me.user.email}，${me.user.role === "admin" ? "管理员" : "普通账号"}`
    : isAdminView(me)
      ? "本地模式（未开启登录），没有可修改的密码"
      : undefined;

  return (
    <SpacePage side="account" title="账号安全" subtitle={who}>
      <section
        aria-label="修改密码"
        className="max-w-[520px] rounded-2xl border border-border bg-card px-[26px] py-6 max-md:px-4"
      >
        <h2 className="mb-1 text-base font-semibold">修改密码</h2>
        <p className="mb-[18px] text-sm text-muted-foreground">
          至少 8 位。管理员给你的初始密码请尽快在这里改掉。
        </p>
        <form
          noValidate
          className="space-y-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-muted-foreground">当前密码</span>
            <Input
              type="password"
              autoComplete="current-password"
              aria-invalid={Boolean(currentErr) || undefined}
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value);
                setFieldErr(null);
              }}
            />
            {currentErr && <span className="text-xs text-destructive">{currentErr}</span>}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-muted-foreground">新密码</span>
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="至少 8 位"
              aria-invalid={Boolean(nextErr) || undefined}
              value={next}
              onChange={(e) => {
                setNext(e.target.value);
                setFieldErr(null);
              }}
            />
            {nextErr && <span className="text-xs text-destructive">{nextErr}</span>}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-muted-foreground">再次输入新密码</span>
            <Input
              type="password"
              autoComplete="new-password"
              aria-invalid={Boolean(confirmErr) || undefined}
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setFieldErr(null);
              }}
            />
            {confirmErr && <span className="text-xs text-destructive">{confirmErr}</span>}
          </label>
          <p aria-live="polite" className="min-h-[18px] text-xs text-destructive">
            {error}
          </p>
          <Button type="submit" disabled={busy || !me?.user}>
            {busy ? "保存中…" : "修改密码"}
          </Button>
        </form>
      </section>
    </SpacePage>
  );
}
