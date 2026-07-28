"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";

export function LoginForm({ firstRun }: { firstRun: boolean }) {
  const router = useRouter();
  // 首次部署(库里还没有用户)默认落在注册页,省掉"先注册再登录"的困惑
  const [mode, setMode] = useState<"login" | "register">(firstRun ? "register" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!email.trim() || !password || busy) return;
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
          <CardTitle className="text-xl">Open Web Agents</CardTitle>
          <CardDescription>
            {mode === "register"
              ? firstRun
                ? "首次部署 —— 创建管理员账号"
                : "创建账号"
              : "登录以继续"}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <label className="space-y-1">
            <span className="text-xs opacity-70">邮箱</span>
            <Input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs opacity-70">
              密码{mode === "register" ? "(至少 8 位)" : ""}
            </span>
            <Input
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </label>

          {error && <p className="text-red-600 text-xs">{error}</p>}

          <Button
            type="button"
            onClick={submit}
            disabled={busy || !email.trim() || !password}
          >
            {busy ? "处理中…" : mode === "register" ? "注册并进入" : "登录"}
          </Button>

          <Button
            type="button"
            variant="link"
            className="text-xs opacity-60 hover:opacity-100"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? "还没有账号?去注册" : "已有账号?去登录"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
