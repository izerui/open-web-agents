"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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

  const field =
    "w-full rounded border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50";

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-8">
      <div>
        <h1 className="font-semibold text-xl">Open Web Agents</h1>
        <p className="text-xs opacity-55">
          {mode === "register"
            ? firstRun
              ? "首次部署 —— 创建管理员账号"
              : "创建账号"
            : "登录以继续"}
        </p>
      </div>

      <label className="space-y-1">
        <span className="text-xs opacity-70">邮箱</span>
        <input
          className={field}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>

      <label className="space-y-1">
        <span className="text-xs opacity-70">密码{mode === "register" ? "(至少 8 位)" : ""}</span>
        <input
          className={field}
          type="password"
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>

      {error && <p className="text-red-600 text-xs">{error}</p>}

      <button
        type="button"
        className="rounded bg-black py-2 text-sm text-white disabled:opacity-40 dark:bg-white dark:text-black"
        onClick={submit}
        disabled={busy || !email.trim() || !password}
      >
        {busy ? "处理中…" : mode === "register" ? "注册并进入" : "登录"}
      </button>

      <button
        type="button"
        className="text-xs underline opacity-60 hover:opacity-100"
        onClick={() => {
          setMode(mode === "login" ? "register" : "login");
          setError(null);
        }}
      >
        {mode === "login" ? "还没有账号?去注册" : "已有账号?去登录"}
      </button>
    </main>
  );
}
