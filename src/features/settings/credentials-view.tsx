"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { SettingsShell } from "@/components/settings-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { refreshMe, useMe } from "@/lib/use-me";

/** 我的模型凭证:base URL 与自带 API Key。 */
export function CredentialsView() {
  const { me } = useMe();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  /**
   * 服务端的 baseUrl 落到输入框。
   *
   * 【为什么依赖的是这个值本身,而不是整个 me】me 对象每次刷新都是新引用,
   * 拿它当依赖会在用户正打字时把输入框重置回服务端的旧值。
   */
  const serverBaseUrl = me?.user?.defaultBaseUrl ?? "";
  useEffect(() => {
    setBaseUrl(serverBaseUrl);
  }, [serverBaseUrl]);

  async function save() {
    setSaving(true);
    try {
      const body: Record<string, string> = { baseUrl };
      // 只有真填了才提交 key,避免空提交把已存的 key 清掉
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      const res = await fetch("/api/me/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (res.ok) toast.success("已保存");
      else toast.error(`保存失败:${data.error}`);
      setApiKey("");
      // 掩码变了,连侧栏用户菜单一起刷新
      await refreshMe();
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    await fetch("/api/me/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "" }),
    });
    toast.success("已清除自带密钥,将回落到平台默认");
    await refreshMe();
  }

  return (
    <SettingsShell
      title="模型凭证"
      subtitle={me?.user ? `${me.user.email} · ${me.user.role}` : undefined}
      width="narrow"
    >
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
              name="model-base-url"
              autoComplete="off"
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
              name="model-api-key"
              // new-password 是唯一能让 Chrome 稳定放弃自动填充的取值,off 会被忽略
              autoComplete="new-password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
            />
          </label>

          <div className="flex items-center gap-3">
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
            {me?.user?.anthropicKeyMask && (
              <Button variant="link" size="sm" onClick={clearKey}>
                清除自带密钥
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </SettingsShell>
  );
}
