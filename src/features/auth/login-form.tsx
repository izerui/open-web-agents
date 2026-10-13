"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AlertTriangle } from "lucide-react";

export function LoginForm({
  firstRun,
  allowSignup,
}: {
  firstRun: boolean;
  /** 平台关闭自助注册时不展示注册入口(第一个账号始终可以注册)。 */
  allowSignup: boolean;
}) {
  const router = useRouter();
  // 首次部署(库里还没有用户)默认落在注册页,省掉"先注册再登录"的困惑
  const [mode, setMode] = useState<"login" | "register">(firstRun ? "register" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 首次部署创建的是管理员,打错一个字符就只能去库里改 —— 要求再输一遍
  const needConfirm = mode === "register" && firstRun;
  const mismatch = needConfirm && confirm.length > 0 && confirm !== password;

  async function submit() {
    if (!email.trim() || !password || busy) return;
    if (needConfirm && confirm !== password) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, email, password }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.replace("/");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8">
      <Card>
        <CardHeader>
          {/* 和全站侧栏同一个徽标 —— 登录是第一眼,不该是唯一没有品牌的页面 */}
          <span className="mb-1 flex size-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-primary-foreground">
            A
          </span>
          <CardTitle className="text-xl">Open Web Agents</CardTitle>
          <CardDescription>
            {mode === "register"
              ? firstRun
                ? "首次部署 —— 创建管理员账号"
                : "创建账号"
              : "登录以继续"}
          </CardDescription>
        </CardHeader>

        {/*
          真正的 <form>:任一输入框回车都能提交,密码管理器也能识别。
          曾经只有密码框监听回车,且没判断输入法组合输入,中文输入法选字时会误提交。
        */}
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">邮箱</span>
              <Input
                type="email"
                name="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">
                密码{mode === "register" ? "(至少 8 位)" : ""}
              </span>
              <Input
                type="password"
                name="password"
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            {needConfirm && (
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">再次输入密码</span>
                <Input
                  type="password"
                  name="confirm-password"
                  autoComplete="new-password"
                  required
                  aria-invalid={mismatch}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
                {mismatch && <span className="text-xs text-destructive">两次输入的密码不一致</span>}
              </label>
            )}

            {/* 原来是硬编码的 text-red-600,不跟主题走,暗色下偏暗看不清 */}
            {error && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={busy || !email.trim() || !password || mismatch}>
              {busy ? "处理中…" : mode === "register" ? "注册并进入" : "登录"}
            </Button>

            {allowSignup && !firstRun && (
              <Button
                type="button"
                variant="link"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setMode(mode === "login" ? "register" : "login");
                  setError(null);
                }}
              >
                {mode === "login" ? "还没有账号?去注册" : "已有账号?去登录"}
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
