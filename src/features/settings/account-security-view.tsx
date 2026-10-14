"use client";

import { SpaceShell } from "@/components/space-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { useMe } from "@/lib/use-me";
import { useState } from "react";
import { toast } from "sonner";

/** 账号安全:修改登录密码。管理员建号或重置后给的是一次性密码,用户应在这里改掉。 */
export function AccountSecurityView() {
  const { me } = useMe();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== next;
  const tooShort = next.length > 0 && next.length < 8;

  async function submit() {
    if (!current || !next || mismatch || tooShort || busy) return;
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
      toast.error(`修改失败:${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SpaceShell title="账号安全" subtitle={me?.user?.email} width="narrow">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">修改登录密码</CardTitle>
          <CardDescription>至少 8 位。管理员给你的初始密码请尽快在这里改掉。</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">当前密码</span>
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">新密码</span>
              <Input
                type="password"
                autoComplete="new-password"
                required
                aria-invalid={tooShort}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
              {tooShort && <span className="text-xs text-destructive">至少 8 位</span>}
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">再次输入新密码</span>
              <Input
                type="password"
                autoComplete="new-password"
                required
                aria-invalid={mismatch}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {mismatch && <span className="text-xs text-destructive">两次输入不一致</span>}
            </label>
            <Button
              type="submit"
              size="sm"
              disabled={busy || !current || !next || mismatch || tooShort}
            >
              {busy ? "保存中…" : "修改密码"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </SpaceShell>
  );
}
