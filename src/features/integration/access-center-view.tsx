"use client";

import type { AgentSummary } from "@/features/workbench/types";
import { Copy, ExternalLink } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { SpaceShell } from "@/components/space-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect as Select } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { InvokeSnippetTabs } from "@/features/integration/invoke-snippet";
import { KeyMonthlyLimit } from "@/features/integration/key-monthly-limit";
import { KeyRateLimit, type PlatformRateLimits } from "@/features/integration/key-rate-limit";
import { WebhookDeliveries } from "@/features/integration/webhook-deliveries";
import { WebhookSecretCard } from "@/features/integration/webhook-secret-card";
import { errorText, fetchJson } from "@/lib/fetch-json";

interface KeyRecord {
  id: string;
  name?: string;
  agentId?: string;
  rateLimitPerMinute?: number;
  /** 本月积分上限(微积分);没有 = 不单独限额 */
  monthlyLimitMicroCredits?: string;
  /** 本月已用(微积分,含在途冻结) */
  monthUsedMicroCredits?: string;
  /** 到期时刻(ms);没有 = 不过期 */
  expiresAt?: number;
  createdAt: number;
  lastUsedAt?: number;
}

/** 到期说明:已过期 / 还剩多久 / 不过期 */
function expiryText(k: KeyRecord, now: number): { text: string; urgent: boolean } | null {
  if (!k.expiresAt) return null;
  const left = k.expiresAt - now;
  if (left <= 0) return { text: "已过期", urgent: true };
  const hours = Math.ceil(left / 3_600_000);
  return hours <= 48
    ? { text: `${hours} 小时后过期`, urgent: true }
    : { text: `${new Date(k.expiresAt).toLocaleDateString()} 过期`, urgent: false };
}

/**
 * 接入中心:第三方系统接入智能体需要的东西都在这一页。
 *
 * 【为什么合并】以前集成方要跑四个地方:这里签 Key、构建器底部翻 curl、
 * 「模型凭证」页设回调签名密钥。
 */
export function AccessCenterView() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const requestedAgent = searchParams.get("agent");
  const objectMode = requestedAgent !== null;
  const initialAgent = useRef(requestedAgent);
  const keyBindingInitialized = useRef(false);
  const reloadSeq = useRef(0);
  const [section, setSection] = useState<"keys" | "docs" | "webhook">(objectMode ? "docs" : "keys");
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  const [keyAgent, setKeyAgent] = useState("");
  const [keyLimit, setKeyLimit] = useState("");
  /** 有效天数;空 = 不过期 */
  const [keyDays, setKeyDays] = useState("");
  const [limits, setLimits] = useState<PlatformRateLimits>({
    perKeyPerMinute: 0,
    perAgentPerMinute: 0,
  });
  /** 新签发的明文,只在本次会话内显示一次 */
  const [issued, setIssued] = useState<{ id: string; plaintext: string } | null>(null);
  const [busy, setBusy] = useState<"issue" | string | null>(null);
  const [keysLoaded, setKeysLoaded] = useState(false);
  const agentName = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const docAgent = objectMode ? agents.find((a) => a.id === requestedAgent) : undefined;
  const contextError =
    objectMode && agentsLoaded && !agentsError && !docAgent
      ? requestedAgent
        ? "找不到指定的智能体,它可能已被删除或你没有访问权限。"
        : "链接缺少智能体 ID,请选择要接入的智能体。"
      : null;
  const visibleKeys =
    objectMode && docAgent
      ? keys.filter((key) => !key.agentId || key.agentId === docAgent.id)
      : keys;
  // 调用方默认拿到的契约:已发布版本的;从未发布则是草稿的
  const contract = docAgent?.published ?? docAgent?.config;

  /**
   * 两块数据各拉各的。
   *
   * 【为什么并行且互不牵连】顺序 await 且不看 res.ok 的话,
   * 任一个挂掉后面的根本不会执行,整页空白且无任何提示。
   * 现在任一块失败只影响它自己,并且说得出是哪一块出了问题。
   */
  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    setKeysLoaded(false);
    setAgentsLoaded(false);
    setKeysError(null);
    setAgentsError(null);
    const [k, a] = await Promise.allSettled([
      fetchJson<{
        keys?: KeyRecord[];
        rateLimits?: PlatformRateLimits;
      }>("/api/keys"),
      fetchJson<{ agents?: AgentSummary[] }>("/api/agents"),
    ]);
    if (seq !== reloadSeq.current) return;

    if (k.status === "fulfilled") {
      setKeys(k.value.keys ?? []);
      if (k.value.rateLimits) setLimits(k.value.rateLimits);
    } else setKeysError(errorText(k.reason));
    setKeysLoaded(true);

    if (a.status === "fulfilled") {
      const available = a.value.agents ?? [];
      setAgents(available);
      // Only the initial deep link supplies a default binding. Changing the
      // documented object or reloading keys must not overwrite an explicit choice.
      if (!keyBindingInitialized.current) {
        const requested = initialAgent.current;
        if (requested && available.some((agent) => agent.id === requested)) {
          setKeyAgent(requested);
        }
        keyBindingInitialized.current = true;
      }
    } else setAgentsError(errorText(a.reason));
    setAgentsLoaded(true);
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      reloadSeq.current++;
    };
  }, [reload]);

  function selectDocAgent(id: string) {
    const query = new URLSearchParams(searchParams.toString());
    if (id) query.set("agent", id);
    else query.delete("agent");
    router.push(`${pathname}${query.size ? `?${query}` : ""}`, { scroll: false });
  }

  async function issueKey() {
    if (busy) return;
    setBusy("issue");
    try {
      const data = await fetchJson<{
        plaintext?: string;
        key?: { id?: string };
      }>("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: keyName.trim() || undefined,
          agentId: keyAgent || undefined,
          rateLimitPerMinute: keyLimit.trim() ? Number(keyLimit) : undefined,
          expiresInDays: keyDays ? Number(keyDays) : undefined,
        }),
      });
      if (!data.plaintext || !data.key?.id) throw new Error("接口没有返回新密钥");
      setIssued({ id: data.key.id, plaintext: data.plaintext });
      setKeyName("");
      setKeyLimit("");
      setKeyDays("");
      await reload();
    } catch (error) {
      toast.error(`签发失败:${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  }

  /** 轮换:签发同名同绑定的新 Key,旧 Key 再有效 24 小时 —— 期间把对接方换上新 Key */
  async function rotateKey(k: KeyRecord) {
    if (
      !window.confirm(
        `轮换「${k.name || "未命名"}」:立即签发一把新 Key,旧 Key 在 24 小时后失效。请在此期间把对接方换成新 Key。`,
      )
    )
      return;
    if (busy) return;
    setBusy(k.id);
    try {
      const data = await fetchJson<{ plaintext?: string; key?: { id?: string } }>(
        `/api/keys/${encodeURIComponent(k.id)}/rotate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ graceHours: 24 }),
        },
      );
      if (!data.plaintext || !data.key?.id) throw new Error("接口没有返回新密钥");
      setIssued({ id: data.key.id, plaintext: data.plaintext });
      await reload();
      toast.success("已签发新 Key,旧 Key 24 小时后失效");
    } catch (error) {
      toast.error(`轮换失败:${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  }

  async function revokeKey(id: string) {
    if (!window.confirm("确定吊销这把 API Key？正在使用它的系统会立即调用失败。")) return;
    if (busy) return;
    setBusy(id);
    try {
      await fetchJson(`/api/keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await reload();
      if (issued?.id === id) setIssued(null);
      toast.success("API Key 已吊销");
    } catch (error) {
      toast.error(`吊销失败:${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  }

  async function copyIssuedKey() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.plaintext);
      toast.success("API Key 已复制");
    } catch (error) {
      toast.error(`复制失败:${errorText(error)}`);
    }
  }

  return (
    <SpaceShell
      title={objectMode ? "API 接入" : "API Key 与接入"}
      object={
        objectMode && docAgent
          ? {
              id: docAgent.id,
              name: docAgent.name,
              tab: "integration",
              canReadConfig: docAgent.canRead !== false,
            }
          : undefined
      }
      width="full"
    >
      {!docAgent && (
        <div className="flex flex-wrap items-center gap-3">
          <Select
            aria-label="选择接入智能体"
            className="w-full sm:max-w-64"
            value=""
            disabled={!agentsLoaded || Boolean(agentsError)}
            onChange={(e) => selectDocAgent(e.target.value)}
          >
            <option value="" disabled>
              选择智能体
            </option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </Select>
          {objectMode && (
            <Button variant="link" size="sm" asChild>
              <Link href="/settings/keys" onClick={() => setSection("keys")}>
                全部 API Key
              </Link>
            </Button>
          )}
        </div>
      )}
      {agentsError && (
        <Alert variant="destructive" className="flex flex-wrap items-center gap-2">
          智能体列表加载失败:{agentsError}
          <Button size="sm" variant="outline" onClick={() => void reload()}>
            重试
          </Button>
        </Alert>
      )}
      {contextError && (
        <Alert variant="destructive">
          <AlertDescription>{contextError}</AlertDescription>
        </Alert>
      )}
      {objectMode && !agentsLoaded && (
        <p className="text-sm text-muted-foreground">正在加载智能体…</p>
      )}
      {(!objectMode || docAgent) && (
        <>
          <nav aria-label="接入分区" className="flex gap-2 border-b border-border pb-2">
            {(
              [
                ["keys", "API Key"],
                ["docs", "调用文档"],
                ["webhook", "Webhook"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                variant={section === value ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={section === value}
                onClick={() => setSection(value)}
              >
                {label}
              </Button>
            ))}
          </nav>
          <section hidden={section !== "keys"} aria-label="API Key">
            <Card className="rounded-none border-0 shadow-none">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-sm">
                    {objectMode ? "可用于此智能体的 API Key" : "我的 API Key"}
                  </CardTitle>
                  {docAgent && (
                    <Button variant="link" size="sm" asChild>
                      <Link href="/settings/keys" onClick={() => setSection("keys")}>
                        全部 API Key
                      </Link>
                    </Button>
                  )}
                </div>
                <CardDescription>
                  从你的后端调用智能体时使用,不要放进浏览器。明文只在签发时显示一次,服务端只存哈希。
                  {docAgent &&
                    " 此处列出绑定当前智能体及不限智能体的 Key;签发范围由「限定智能体」单独决定。"}
                </CardDescription>
                <CardDescription>
                  {limits.perKeyPerMinute > 0
                    ? `调用限流:每把 Key 默认每分钟最多 ${limits.perKeyPerMinute} 次新调用(可单独调低)`
                    : "调用限流:每把 Key 默认不限(可单独设置)"}
                  {limits.perAgentPerMinute > 0 &&
                    `,每个智能体所有 Key 合计每分钟最多 ${limits.perAgentPerMinute} 次`}
                  ;超出返回 429 并带 Retry-After。用同一个 Idempotency-Key 重试已受理的请求不计入。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* 窄屏换行:五个控件挤一行时备注框只剩两个字宽,手机上还会横向溢出 */}
                <div className="flex flex-wrap gap-2">
                  <Input
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                    placeholder="用途备注,如「订单系统」"
                    aria-label="用途备注"
                    className="min-w-48 flex-1"
                  />
                  <Input
                    type="number"
                    min={1}
                    value={keyLimit}
                    onChange={(e) => setKeyLimit(e.target.value)}
                    placeholder={`每分钟上限(默认 ${limits.perKeyPerMinute || "不限"})`}
                    aria-label="每分钟调用上限"
                    className="w-full sm:w-52"
                  />
                  <Select
                    value={keyDays}
                    onChange={(e) => setKeyDays(e.target.value)}
                    aria-label="有效期"
                    className="w-[calc(50%-0.25rem)] sm:w-32"
                  >
                    <option value="">不过期</option>
                    <option value="30">30 天</option>
                    <option value="90">90 天</option>
                    <option value="365">1 年</option>
                  </Select>
                  <Select
                    value={keyAgent}
                    onChange={(e) => {
                      keyBindingInitialized.current = true;
                      setKeyAgent(e.target.value);
                    }}
                    aria-label="限定智能体"
                    className="w-[calc(50%-0.25rem)] sm:w-40"
                  >
                    <option value="">不限智能体</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        仅 {a.name}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    className="shrink-0"
                    onClick={() => void issueKey()}
                    disabled={
                      busy !== null ||
                      Boolean(
                        keyAgent && (!agentsLoaded || agentsError || !agentName.has(keyAgent)),
                      )
                    }
                  >
                    {busy === "issue" ? "签发中…" : "签发"}
                  </Button>
                </div>

                {issued && (
                  <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3">
                    <p className="font-medium text-xs">请立刻保存 —— 关闭后无法再次显示:</p>
                    <code className="block break-all font-mono text-xs">{issued.plaintext}</code>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={() => void copyIssuedKey()}
                      >
                        <Copy className="size-3.5" />
                        复制
                      </Button>
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0"
                        onClick={() => setIssued(null)}
                      >
                        我已保存
                      </Button>
                    </div>
                  </div>
                )}

                <Separator />

                {keysError && (
                  <Alert variant="destructive" className="flex flex-wrap items-center gap-2">
                    API Key 列表加载失败:{keysError}
                    <Button size="sm" variant="outline" onClick={() => void reload()}>
                      重试
                    </Button>
                  </Alert>
                )}
                <div className="divide-y divide-border rounded border">
                  {!keysLoaded && <p className="p-3 text-xs text-muted-foreground">载入中…</p>}
                  {keysLoaded && !keysError && visibleKeys.length === 0 && (
                    <p className="p-3 text-xs text-muted-foreground">暂无 key</p>
                  )}
                  {visibleKeys.map((k) => (
                    <div key={k.id} className="flex flex-wrap items-center gap-3 p-2 text-xs">
                      <span className="flex-1 truncate">
                        {k.name || "(未命名)"}
                        {k.agentId && (
                          <Badge variant="secondary" className="ml-1.5 text-[10px]">
                            仅 {agentName.get(k.agentId) ?? k.agentId}
                          </Badge>
                        )}
                      </span>
                      <KeyRateLimit
                        keyId={k.id}
                        value={k.rateLimitPerMinute}
                        platform={limits.perKeyPerMinute}
                        onSaved={reload}
                      />
                      <KeyMonthlyLimit
                        keyId={k.id}
                        limitMicro={k.monthlyLimitMicroCredits}
                        usedMicro={k.monthUsedMicroCredits ?? "0"}
                        onSaved={reload}
                      />
                      <span className="text-muted-foreground">
                        {k.lastUsedAt
                          ? `最近使用 ${new Date(k.lastUsedAt).toLocaleDateString()}`
                          : "从未使用"}
                      </span>
                      {(() => {
                        const e = expiryText(k, Date.now());
                        return e ? (
                          <span className={e.urgent ? "text-destructive" : "text-muted-foreground"}>
                            {e.text}
                          </span>
                        ) : null;
                      })()}
                      <Button
                        variant="link"
                        size="sm"
                        className="h-8 shrink-0 px-2"
                        disabled={
                          busy !== null || (k.expiresAt !== undefined && k.expiresAt <= Date.now())
                        }
                        onClick={() => void rotateKey(k)}
                      >
                        轮换
                      </Button>
                      {/*
                  【为什么不是 h-auto p-0】那样按钮只有文字那么高(约 20px),
                  低于 24px 的最小触控尺寸,手机上很难点准 —— 而这是【吊销】,
                  一个不可撤销的破坏性操作,点不准的代价是误吊销一把还在用的 key。
                */}
                      <Button
                        variant="link"
                        size="sm"
                        className="h-8 shrink-0 px-2 text-destructive"
                        disabled={busy !== null}
                        onClick={() => void revokeKey(k.id)}
                      >
                        吊销
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </section>

          <section hidden={section !== "docs"} aria-label="调用文档">
            <Card className="rounded-none border-0 shadow-none">
              <CardHeader>
                <CardTitle className="text-sm">接口文档与调用代码</CardTitle>
                <CardDescription>
                  按智能体生成:入参示例按它的输入契约(inputSchema)生成,并用平台同款校验器复核。
                  调用是异步的 —— 提交拿 taskId,轮询结果或等 Webhook 回调。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!agentsLoaded ? (
                  <p className="text-sm text-muted-foreground">正在加载智能体…</p>
                ) : agentsError ? (
                  <p className="text-sm text-muted-foreground">智能体列表恢复后可查看调用文档。</p>
                ) : agents.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    还没有可调用的智能体,先去{" "}
                    <Link href="/agents" className="underline">
                      智能体
                    </Link>{" "}
                    建一个。
                  </p>
                ) : !docAgent ? (
                  <p className="text-sm text-muted-foreground">
                    选择智能体以查看它的调用契约与代码。
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      {docAgent.published ? (
                        <Badge variant="success" className="text-[11px]">
                          已发布 v{docAgent.published.version}
                        </Badge>
                      ) : (
                        <Badge variant="warning" className="text-[11px]">
                          未发布 · 调用使用草稿
                        </Badge>
                      )}
                      <Badge variant="secondary" className="text-[11px]">
                        {contract?.inputSchema ? "结构化入参" : "文本入参"}
                      </Badge>
                      <Badge variant="secondary" className="text-[11px]">
                        {contract?.outputSchema ? "结构化结果 structured" : "文本结果 text"}
                      </Badge>
                      <Button variant="link" size="sm" className="ml-auto h-8 px-2" asChild>
                        <a
                          href={`/api/agents/${encodeURIComponent(docAgent.id)}/openapi.json`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          OpenAPI 文档
                          <ExternalLink className="size-3.5" />
                        </a>
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {docAgent.published
                        ? `调用默认使用当前发布的版本(v${docAgent.published.version}),发布新版本后自动切换;需要固定某一版时在请求体里加 "version": ${docAgent.published.version}。`
                        : "这个智能体还没有发布:调用直接使用草稿,作者保存即生效。对外稳定使用前,建议在构建器里发布一个版本。"}
                      {docAgent.hasUnpublishedChanges && " 草稿里还有未发布的修改,不影响调用方。"}
                    </p>
                    <InvokeSnippetTabs
                      key={`${docAgent.id}@${docAgent.published?.version ?? "draft"}`}
                      agentId={docAgent.id}
                      inputSchema={contract?.inputSchema}
                      hasOutputSchema={Boolean(contract?.outputSchema)}
                    />
                    <p className="text-xs text-muted-foreground">
                      <Link
                        href={`/settings/runs?agent=${encodeURIComponent(docAgent.id)}`}
                        className="underline"
                      >
                        运行记录
                      </Link>
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </section>

          <section hidden={section !== "webhook"} aria-label="Webhook" className="space-y-6">
            {docAgent ? (
              <>
                <div className="space-y-3">
                  <h2 className="text-sm font-medium">结果回调</h2>
                  {docAgent.canManageWebhook ? (
                    <>
                      <p className="break-all text-sm text-muted-foreground">
                        {docAgent.webhookUrl || "尚未配置回调地址"}
                      </p>
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/agents?id=${encodeURIComponent(docAgent.id)}`}>
                          配置回调地址
                        </Link>
                      </Button>
                      {section === "webhook" && (
                        <WebhookDeliveries
                          key={docAgent.id}
                          agentId={docAgent.id}
                          webhookUrl={docAgent.webhookUrl}
                        />
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      回调地址与投递记录由智能体所有者管理。
                    </p>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  回调使用智能体所有者的账号签名密钥。
                  <Link
                    href="/settings/keys"
                    onClick={() => setSection("webhook")}
                    className="ml-1 underline"
                  >
                    管理我名下智能体的签名密钥
                  </Link>
                </p>
              </>
            ) : (
              <WebhookSecretCard />
            )}
          </section>
        </>
      )}
    </SpaceShell>
  );
}
