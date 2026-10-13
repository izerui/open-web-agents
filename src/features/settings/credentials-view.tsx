"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { SpaceShell } from "@/components/space-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { refreshMe, useMe } from "@/lib/use-me";

/** 我的模型凭证:base URL 与自带 API Key。 */
export function CredentialsView() {
  const { me } = useMe();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [customSecret, setCustomSecret] = useState("");
  /** 刚生成/设置的明文。只在这一次展示,刷新后只剩掩码。 */
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

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
      await fetchJson("/api/me/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast.success("已保存");
      setApiKey("");
      // 掩码变了,连侧栏用户菜单一起刷新
      await refreshMe();
    } catch (error) {
      toast.error(`保存失败:${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    if (!window.confirm("确定清除自带 API Key？后续运行将改用平台默认凭证。")) return;
    if (saving) return;
    setSaving(true);
    try {
      await fetchJson("/api/me/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "" }),
      });
      toast.success("已清除自带密钥,将回落到平台默认");
      await refreshMe();
    } catch (error) {
      toast.error(`清除失败:${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveWebhookSecret(generate: boolean) {
    if (saving) return;
    setSaving(true);
    try {
      const data = await fetchJson<{ secret: string }>("/api/me/webhook-secret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(generate ? {} : { secret: customSecret.trim() }),
      });
      setRevealedSecret(data.secret);
      setCustomSecret("");
      toast.success(generate ? "已生成新的签名密钥" : "已保存签名密钥");
      await refreshMe();
    } catch (error) {
      toast.error(`保存失败:${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function clearWebhookSecret() {
    if (!window.confirm("确定清除签名密钥？之后的回调将不再带签名头。")) return;
    if (saving) return;
    setSaving(true);
    try {
      await fetchJson("/api/me/webhook-secret", { method: "DELETE" });
      setRevealedSecret(null);
      toast.success("已清除签名密钥");
      await refreshMe();
    } catch (error) {
      toast.error(`清除失败:${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  const webhookMask = me?.user?.webhookSecretMask ?? null;

  return (
    <SpaceShell
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
              <Button variant="link" size="sm" onClick={() => void clearKey()} disabled={saving}>
                清除自带密钥
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm">Webhook 签名密钥</CardTitle>
          <CardDescription>
            你名下所有智能体的结果回调都用它签名:请求头 X-OWA-Signature ={" "}
            <code>v1=HMAC-SHA256(密钥, "时间戳.请求体")</code>,时间戳见 X-OWA-Timestamp。
            接收方用同一个密钥验签,确认回调来自平台且未被篡改。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            当前:{webhookMask ? webhookMask : "未配置(回调不带签名)"}
          </p>

          {revealedSecret && (
            <div className="space-y-1 rounded-md border p-3">
              <p className="text-xs text-muted-foreground">
                请立即复制保存,离开本页后只能看到掩码:
              </p>
              <code className="block break-all text-xs">{revealedSecret}</code>
            </div>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">
              自定义密钥(至少 24 个字符;留空可直接生成)
            </span>
            <Input
              type="password"
              name="webhook-secret"
              autoComplete="new-password"
              value={customSecret}
              onChange={(e) => setCustomSecret(e.target.value)}
            />
          </label>

          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={() => void saveWebhookSecret(false)}
              disabled={saving || !customSecret.trim()}
            >
              使用自定义密钥
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void saveWebhookSecret(true)}
              disabled={saving}
            >
              {webhookMask ? "重新生成" : "生成密钥"}
            </Button>
            {webhookMask && (
              <Button
                variant="link"
                size="sm"
                onClick={() => void clearWebhookSecret()}
                disabled={saving}
              >
                清除
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </SpaceShell>
  );
}
