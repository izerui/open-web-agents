"use client";

import type { AssistantSummary } from "@/features/workbench/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface Me {
  authenticated: boolean;
  user?: {
    id: string;
    email: string;
    role: string;
    defaultBaseUrl: string | null;
    anthropicKeyMask: string | null;
  };
}

interface KeyRecord {
  id: string;
  name?: string;
  assistantId?: string;
  createdAt: number;
  lastUsedAt?: number;
}

const field =
  "w-full rounded border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50";

export function SettingsView() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [credMsg, setCredMsg] = useState<string | null>(null);

  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [assistants, setAssistants] = useState<AssistantSummary[]>([]);
  const [keyName, setKeyName] = useState("");
  const [keyAssistant, setKeyAssistant] = useState("");
  /** 新签发的明文,只在本次会话内显示一次 */
  const [issued, setIssued] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const m = (await fetch("/api/auth").then((r) => r.json())) as Me;
    setMe(m);
    setBaseUrl(m.user?.defaultBaseUrl ?? "");
    const k = (await fetch("/api/keys").then((r) => r.json())) as { keys?: KeyRecord[] };
    setKeys(k.keys ?? []);
    const a = (await fetch("/api/assistants").then((r) => r.json())) as {
      assistants?: AssistantSummary[];
    };
    setAssistants(a.assistants ?? []);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function saveCredentials() {
    setCredMsg(null);
    const body: Record<string, string> = { baseUrl };
    // 只有真填了才提交 key,避免空提交把已存的 key 清掉
    if (apiKey.trim()) body.apiKey = apiKey.trim();
    const res = await fetch("/api/me/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { error?: string; anthropicKeyMask?: string | null };
    setCredMsg(res.ok ? "已保存" : `保存失败:${data.error}`);
    setApiKey("");
    await reload();
  }

  async function clearKey() {
    await fetch("/api/me/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "" }),
    });
    setCredMsg("已清除自带密钥,将回落到平台默认");
    await reload();
  }

  async function issueKey() {
    const res = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: keyName.trim() || undefined,
        assistantId: keyAssistant || undefined,
      }),
    });
    const data = (await res.json()) as { plaintext?: string; error?: string };
    if (data.plaintext) {
      setIssued(data.plaintext);
      setKeyName("");
      await reload();
    } else {
      setIssued(null);
      setCredMsg(`签发失败:${data.error}`);
    }
  }

  async function revokeKey(id: string) {
    await fetch(`/api/keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await reload();
  }

  async function logout() {
    await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    router.replace("/login");
    router.refresh();
  }

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-lg">设置</h1>
          <p className="text-xs opacity-55">
            {me?.user ? `${me.user.email} · ${me.user.role}` : "未登录"}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <Link href="/" className="underline opacity-60 hover:opacity-100">
            工作台
          </Link>
          <Link href="/builder" className="underline opacity-60 hover:opacity-100">
            构建器
          </Link>
          <Link href="/usage" className="underline opacity-60 hover:opacity-100">
            用量
          </Link>
          <button type="button" className="underline opacity-60 hover:opacity-100" onClick={logout}>
            登出
          </button>
        </div>
      </header>

      <section className="space-y-3">
        <div>
          <h2 className="font-medium text-sm">我的模型凭证</h2>
          <p className="text-xs opacity-55">
            优先级:请求覆盖 &gt; 会话 &gt; 这里 &gt; 平台默认。密钥加密入库,只在运行时解密注入
            agent。
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-xs opacity-70">Base URL(留空用平台默认)</span>
          <input
            className={field}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.anthropic.com"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs opacity-70">
            API Key
            {me?.user?.anthropicKeyMask ? `(当前:${me.user.anthropicKeyMask},留空则不修改)` : ""}
          </span>
          <input
            className={field}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded bg-black px-4 py-1.5 text-sm text-white dark:bg-white dark:text-black"
            onClick={saveCredentials}
          >
            保存
          </button>
          {me?.user?.anthropicKeyMask && (
            <button
              type="button"
              className="text-xs underline opacity-60 hover:opacity-100"
              onClick={clearKey}
            >
              清除自带密钥
            </button>
          )}
          {credMsg && <span className="text-xs opacity-70">{credMsg}</span>}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="font-medium text-sm">对外 API Key</h2>
          <p className="text-xs opacity-55">
            给第三方系统调用助手用。明文只在签发时显示一次,服务端只存哈希。
          </p>
        </div>

        <div className="flex gap-2">
          <input
            className={field}
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="用途备注,如「订单系统」"
          />
          <select
            className={field}
            value={keyAssistant}
            onChange={(e) => setKeyAssistant(e.target.value)}
          >
            <option value="">不限助手</option>
            {assistants.map((a) => (
              <option key={a.id} value={a.id}>
                仅 {a.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="shrink-0 rounded bg-black px-4 py-1.5 text-sm text-white dark:bg-white dark:text-black"
            onClick={issueKey}
          >
            签发
          </button>
        </div>

        {issued && (
          <div className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="font-medium text-xs">请立刻保存 —— 关闭后无法再次显示:</p>
            <code className="block break-all font-mono text-xs">{issued}</code>
            <button
              type="button"
              className="text-xs underline opacity-70 hover:opacity-100"
              onClick={() => setIssued(null)}
            >
              我已保存
            </button>
          </div>
        )}

        <div className="divide-y divide-black/10 rounded border border-black/10 dark:divide-white/10 dark:border-white/15">
          {keys.length === 0 && <p className="p-3 text-xs opacity-40">暂无 key</p>}
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-3 p-2 text-xs">
              <span className="flex-1 truncate">
                {k.name || "(未命名)"}
                {k.assistantId && <span className="ml-1 opacity-50">· 仅 {k.assistantId}</span>}
              </span>
              <span className="opacity-45">
                {k.lastUsedAt
                  ? `最近使用 ${new Date(k.lastUsedAt).toLocaleDateString()}`
                  : "从未使用"}
              </span>
              <button
                type="button"
                className="text-red-600 underline opacity-70 hover:opacity-100"
                onClick={() => revokeKey(k.id)}
              >
                吊销
              </button>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
