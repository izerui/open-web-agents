"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { refreshMe, useMe } from "@/lib/use-me";

/** 每个用户自己的 Webhook 签名密钥:名下所有智能体的结果回调都用它签名。 */
export function WebhookSecretCard() {
  const { me } = useMe();
  const [saving, setSaving] = useState(false);
  const [customSecret, setCustomSecret] = useState("");
  /** 刚生成/设置的明文。只在这一次展示,刷新后只剩掩码。 */
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  async function saveWebhookSecret(generate: boolean) {
    if (saving) return;
    setSaving(true);
    try {
      const data = await fetchJson<{ secret: string; previousValidUntil?: string | null }>(
        "/api/me/webhook-secret",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(generate ? {} : { secret: customSecret.trim() }),
        },
      );
      setRevealedSecret(data.secret);
      // 换了新密钥:旧密钥在重叠期内仍额外签一份,提醒接收方在这之前换上新密钥
      if (data.previousValidUntil) {
        toast.message(
          `旧密钥在 ${new Date(data.previousValidUntil).toLocaleString()} 前仍会额外签名(X-OWA-Signature-Previous),请在此之前把接收方换成新密钥`,
          { duration: 15_000 },
        );
      }
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
    <Card>
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
            <p className="text-xs text-muted-foreground">请立即复制保存,离开本页后只能看到掩码:</p>
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
  );
}
