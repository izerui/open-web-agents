"use client";

import type { AssistantSummary } from "@/features/workbench/types";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect as Select } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";

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

export function SettingsView() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

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
    const body: Record<string, string> = { baseUrl };
    // 只有真填了才提交 key,避免空提交把已存的 key 清掉
    if (apiKey.trim()) body.apiKey = apiKey.trim();
    const res = await fetch("/api/me/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { error?: string; anthropicKeyMask?: string | null };
    if (res.ok) {
      toast.success("已保存");
    } else {
      toast.error(`保存失败:${data.error}`);
    }
    setApiKey("");
    await reload();
  }

  async function clearKey() {
    await fetch("/api/me/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "" }),
    });
    toast.success("已清除自带密钥,将回落到平台默认");
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
      toast.error(`签发失败:${data.error}`);
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

  const logoutButton = (
    <Button variant="ghost" size="sm" onClick={logout}>
      登出
    </Button>
  );

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <AppHeader
        title="设置"
        subtitle={me?.user ? `${me.user.email} · ${me.user.role}` : "未登录"}
        actions={logoutButton}
      />

      {/* ── 模型凭证 ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">我的模型凭证</CardTitle>
          <CardDescription>
            优先级:请求覆盖 &gt; 会话 &gt; 这里 &gt; 平台默认。密钥加密入库,只在运行时解密注入
            agent。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Base URL(留空用平台默认)</span>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.anthropic.com"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">
              API Key
              {me?.user?.anthropicKeyMask ? `(当前:${me.user.anthropicKeyMask},留空则不修改)` : ""}
            </span>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
            />
          </label>

          <div className="flex items-center gap-3">
            <Button size="sm" onClick={saveCredentials}>
              保存
            </Button>
            {me?.user?.anthropicKeyMask && (
              <Button variant="link" size="sm" onClick={clearKey}>
                清除自带密钥
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── 对外 API Key ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">对外 API Key</CardTitle>
          <CardDescription>
            给第三方系统调用助手用。明文只在签发时显示一次,服务端只存哈希。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="用途备注,如「订单系统」"
            />
            <Select value={keyAssistant} onChange={(e) => setKeyAssistant(e.target.value)}>
              <option value="">不限助手</option>
              {assistants.map((a) => (
                <option key={a.id} value={a.id}>
                  仅 {a.name}
                </option>
              ))}
            </Select>
            <Button size="sm" className="shrink-0" onClick={issueKey}>
              签发
            </Button>
          </div>

          {issued && (
            <div className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="font-medium text-xs">请立刻保存 —— 关闭后无法再次显示:</p>
              <code className="block break-all font-mono text-xs">{issued}</code>
              <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setIssued(null)}>
                我已保存
              </Button>
            </div>
          )}

          <Separator />

          <div className="divide-y divide-border rounded border">
            {keys.length === 0 && (
              <p className="p-3 text-xs text-muted-foreground">暂无 key</p>
            )}
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-3 p-2 text-xs">
                <span className="flex-1 truncate">
                  {k.name || "(未命名)"}
                  {k.assistantId && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">
                      仅 {k.assistantId}
                    </Badge>
                  )}
                </span>
                <span className="text-muted-foreground">
                  {k.lastUsedAt
                    ? `最近使用 ${new Date(k.lastUsedAt).toLocaleDateString()}`
                    : "从未使用"}
                </span>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-destructive"
                  onClick={() => revokeKey(k.id)}
                >
                  吊销
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
