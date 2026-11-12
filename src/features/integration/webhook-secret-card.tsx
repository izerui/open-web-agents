"use client";

import { Check, Clock, Copy, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useConfirm } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Banner, CardHead } from "@/features/settings/space-page";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatTime } from "@/lib/format-time";
import { refreshMe, useMe } from "@/lib/use-me";

const MIN_SECRET = 24;

/** 每个用户自己的 Webhook 签名密钥:名下所有智能体的结果回调都用它签名。 */
export function WebhookSecretCard() {
  const { me } = useMe();
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);
  const [customSecret, setCustomSecret] = useState("");
  const [inputError, setInputError] = useState("");
  /** 刚生成/设置的明文。只在这一次展示,刷新后只剩掩码。 */
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  /** 换密钥后旧密钥继续额外签名到这个时刻 */
  const [previousUntil, setPreviousUntil] = useState<string | null>(null);

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
      setPreviousUntil(data.previousValidUntil ?? null);
      setCustomSecret("");
      setInputError("");
      toast.success(generate ? "已生成新的签名密钥" : "已改用自定义密钥");
      await refreshMe();
    } catch (error) {
      toast.error(`保存失败:${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function clearWebhookSecret() {
    if (saving) return;
    setSaving(true);
    try {
      await fetchJson("/api/me/webhook-secret", { method: "DELETE" });
      setRevealedSecret(null);
      setPreviousUntil(null);
      toast.success("已清除签名密钥");
      await refreshMe();
    } catch (error) {
      toast.error(`清除失败:${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  function useCustom() {
    const v = customSecret.trim();
    if (!v) return setInputError("请输入密钥,或直接点「生成」");
    if (v.length < MIN_SECRET)
      return setInputError(`至少 ${MIN_SECRET} 个字符,现在 ${v.length} 个`);
    setInputError("");
    void saveWebhookSecret(false);
  }

  async function copySecret() {
    if (!revealedSecret) return;
    try {
      await navigator.clipboard.writeText(revealedSecret);
      toast.success("已复制到剪贴板");
    } catch (error) {
      toast.error(`复制失败:${errorText(error)}`);
    }
  }

  const webhookMask = me?.user?.webhookSecretMask ?? null;

  return (
    <section aria-label="Webhook 签名密钥" className="rounded-2xl border border-border bg-card">
      <CardHead
        title="Webhook 签名密钥"
        meta={<Badge variant="outline">账号级，所有智能体共用</Badge>}
      />
      <div className="px-[22px] pb-[22px] max-md:px-4">
        <p className="mb-2.5 text-sm">
          你名下所有智能体的结果回调都用这把密钥签名，接收方用同一把密钥验签，确认回调来自平台且没被篡改。
        </p>
        <pre className="overflow-x-auto rounded-xl bg-[#1F1E1C] px-4 py-3.5 font-mono text-[13px] leading-relaxed text-[#EAE6DC]">
          <span className="text-[#A29D90]"># 每次回调带两个请求头</span>
          {"\nX-OWA-Timestamp: "}
          <span className="text-[#A9CFA4]">1762866000</span>
          {"\nX-OWA-Signature: "}
          <span className="text-[#A9CFA4]">v1=</span>
          {"HMAC-SHA256(密钥, "}
          <span className="text-[#A9CFA4]">"时间戳.请求体"</span>
          {") 的十六进制\n"}
          <span className="text-[#A29D90]"># 重新生成后的过渡期内，旧密钥额外签一份</span>
          {"\nX-OWA-Signature-Previous: "}
          <span className="text-[#A9CFA4]">v1=…</span>
        </pre>
        <div className="mt-4 mb-1 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">当前密钥</span>
          {webhookMask ? (
            <>
              <code className="break-all font-mono text-[13px]">{webhookMask}</code>
              <Badge variant="success">已配置</Badge>
            </>
          ) : (
            <>
              <Badge>未配置</Badge>
              <span className="text-xs text-muted-foreground">
                回调不带签名，接收方无法验证来源
              </span>
            </>
          )}
        </div>
        {previousUntil && (
          <Banner tone="warn" icon={<Clock />} className="mt-2.5 mb-0">
            旧密钥在 <b>{formatTime(new Date(previousUntil).getTime())}</b>{" "}
            前仍会额外签名（X-OWA-Signature-Previous），请在这之前把接收方换成新密钥。
          </Banner>
        )}
        {revealedSecret && (
          <div className="mt-3 rounded-[14px] border border-[#D3E2D6] bg-[#F3F7F3] px-4 py-3.5">
            <p className="flex items-center gap-2 font-semibold text-success-text">
              <Check className="size-[18px]" />
              新密钥只显示这一次
            </p>
            <div className="my-2.5 flex items-center gap-3 rounded-xl bg-[#1F1E1C] px-4 py-3 font-mono text-sm text-[#F2EFE7]">
              <code className="min-w-0 flex-1 break-all">{revealedSecret}</code>
              <Button size="sm" variant="outline" onClick={() => void copySecret()}>
                <Copy className="size-[15px]" />
                复制
              </Button>
            </div>
            <Button size="sm" onClick={() => setRevealedSecret(null)}>
              我已保存
            </Button>
          </div>
        )}
        <div className="mt-4 flex flex-col gap-1.5">
          <label htmlFor="webhook-secret" className="text-[13px] text-muted-foreground">
            自定义密钥（至少 {MIN_SECRET} 个字符；留空可直接生成）
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="webhook-secret"
              type="password"
              name="webhook-secret"
              autoComplete="new-password"
              placeholder="粘贴你自己的密钥"
              className="min-w-0 flex-1 basis-48"
              value={customSecret}
              onChange={(e) => {
                setCustomSecret(e.target.value);
                setInputError("");
              }}
            />
            <Button variant="outline" disabled={saving} onClick={useCustom}>
              使用自定义密钥
            </Button>
          </div>
          <span aria-live="polite" className="min-h-[18px] text-xs text-destructive">
            {inputError}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {webhookMask ? (
            <>
              <Button
                disabled={saving}
                onClick={() =>
                  confirm.ask({
                    title: "重新生成签名密钥？",
                    description:
                      "新密钥立即生效，之后的回调用新密钥签 X-OWA-Signature。过渡期内旧密钥会继续用 X-OWA-Signature-Previous 额外签一份，接收方来得及换密钥，验签不中断。",
                    confirmLabel: "重新生成",
                    onConfirm: () => saveWebhookSecret(true),
                  })
                }
              >
                <RefreshCw />
                重新生成
              </Button>
              <Button
                variant="destructive"
                disabled={saving}
                onClick={() =>
                  confirm.ask({
                    title: "清除签名密钥？",
                    description:
                      "清除后，你名下所有智能体的回调都不再带签名，接收方如果在验签会全部拒收。",
                    confirmLabel: "清除",
                    destructive: true,
                    onConfirm: clearWebhookSecret,
                  })
                }
              >
                清除
              </Button>
            </>
          ) : (
            <Button disabled={saving} onClick={() => void saveWebhookSecret(true)}>
              <Sparkles />
              生成密钥
            </Button>
          )}
        </div>
      </div>
      {confirm.dialog}
    </section>
  );
}
