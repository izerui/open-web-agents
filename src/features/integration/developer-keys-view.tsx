"use client";

import {
  Check,
  ChevronRight,
  Clock,
  Copy,
  Info,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AgentAvatar } from "@/components/agent-avatar";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { KeyMonthlyLimit } from "@/features/integration/key-monthly-limit";
import { KeyRateLimit, type PlatformRateLimits } from "@/features/integration/key-rate-limit";
import { WebhookSecretCard } from "@/features/integration/webhook-secret-card";
import { Banner, CardHead, EmptyState, SpacePage, tb } from "@/features/settings/space-page";
import { shortTime } from "@/features/settings/time-format";
import type { AgentSummary } from "@/features/workbench/types";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatTime } from "@/lib/format-time";
import { agentHref } from "@/lib/nav/routes";
import { isAdminView, useMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import {
  accessStatusText,
  keyExpiry,
  keyLabel,
  parseRpmDraft,
  rotatedOldKeys,
  rpmHint,
  rpmRangeText,
} from "./key-display";

interface KeyRecord {
  id: string;
  name?: string;
  /** 认 Key 用的尾号;加列之前签发的没有 */
  keyHint?: string;
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

type Issued = { id: string; plaintext: string; name: string; agentId?: string; hint: string };

/** 轮换的重叠期(小时) */
const GRACE_HOURS = 24;

/**
 * 开发者 · API Key 与签名密钥(原 /settings/keys 的账号级部分)。
 * 单个智能体的调用代码、在线试调、Webhook 地址与投递记录在它的构建页「接入」阶段 ——
 * 这里只给入口,不再有 ?agent= 的单智能体模式。
 */
export function DeveloperKeysView() {
  const { me } = useMe();
  const confirm = useConfirm();
  const reloadSeq = useRef(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [keysLoaded, setKeysLoaded] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [limits, setLimits] = useState<PlatformRateLimits>({
    perKeyPerMinute: 0,
    perAgentPerMinute: 0,
  });
  const [keyName, setKeyName] = useState("");
  const [keyLimit, setKeyLimit] = useState("");
  /** 有效天数;空 = 不过期 */
  const [keyDays, setKeyDays] = useState("");
  const [keyAgent, setKeyAgent] = useState("");
  const [formError, setFormError] = useState("");
  /** 报错对应的输入框,标红并把焦点放过去 */
  const [errField, setErrField] = useState<"name" | "rpm" | null>(null);
  const rpmRef = useRef<HTMLInputElement>(null);
  const rpmMax = isAdminView(me) ? 0 : limits.perKeyPerMinute;
  /** 新签发的明文,只在本次会话内显示一次 */
  const [issued, setIssued] = useState<Issued | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  /** Key 与智能体各拉各的:任一块失败只影响它自己,并说得出是哪一块 */
  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    setKeysError(null);
    setAgentsError(null);
    const [k, a] = await Promise.allSettled([
      fetchJson<{ keys?: KeyRecord[]; rateLimits?: PlatformRateLimits }>("/api/keys"),
      fetchJson<{ agents?: AgentSummary[] }>("/api/agents"),
    ]);
    if (seq !== reloadSeq.current) return;
    if (k.status === "fulfilled") {
      setKeys(k.value.keys ?? []);
      if (k.value.rateLimits) setLimits(k.value.rateLimits);
    } else setKeysError(errorText(k.reason));
    setKeysLoaded(true);
    if (a.status === "fulfilled") setAgents(a.value.agents ?? []);
    else setAgentsError(errorText(a.reason));
    setAgentsLoaded(true);
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      reloadSeq.current++;
    };
  }, [reload]);

  async function retry() {
    setKeysLoaded(false);
    setAgentsLoaded(false);
    await reload();
  }

  async function issueKey() {
    if (busy) return;
    const name = keyName.trim();
    if (!name) {
      setErrField("name");
      nameRef.current?.focus();
      return setFormError("请填写用途备注，方便以后认出这个 Key");
    }
    if (keyLimit.trim()) {
      const r = parseRpmDraft(keyLimit, rpmMax);
      if (!r.ok) {
        setErrField("rpm");
        rpmRef.current?.focus();
        return setFormError(`每分钟上限${r.error.replace(/^填/, "要填")}，留空用默认`);
      }
    }
    setFormError("");
    setErrField(null);
    setBusy("issue");
    try {
      const data = await fetchJson<{ plaintext?: string; key?: { id?: string; keyHint?: string } }>(
        "/api/keys",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            agentId: keyAgent || undefined,
            rateLimitPerMinute: keyLimit.trim() ? Number(keyLimit) : undefined,
            expiresInDays: keyDays ? Number(keyDays) : undefined,
          }),
        },
      );
      if (!data.plaintext || !data.key?.id) throw new Error("接口没有返回新密钥");
      setIssued({
        id: data.key.id,
        plaintext: data.plaintext,
        hint: data.key.keyHint ?? keyLabel({ id: data.key.id }),
        name,
        agentId: keyAgent || undefined,
      });
      setKeyName("");
      setKeyLimit("");
      setKeyDays("");
      toast.success("Key 已签发，请立即复制");
      await reload();
    } catch (error) {
      setFormError(`签发失败：${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  }

  /** 轮换:签发同名同绑定的新 Key,旧 Key 再有效 24 小时 —— 期间把对接方换上新 Key */
  async function rotateKey(k: KeyRecord) {
    setBusy(k.id);
    try {
      const data = await fetchJson<{ plaintext?: string; key?: { id?: string; keyHint?: string } }>(
        `/api/keys/${encodeURIComponent(k.id)}/rotate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ graceHours: GRACE_HOURS }),
        },
      );
      if (!data.plaintext || !data.key?.id) throw new Error("接口没有返回新密钥");
      setIssued({
        id: data.key.id,
        plaintext: data.plaintext,
        hint: data.key.keyHint ?? keyLabel({ id: data.key.id }),
        name: k.name || "未命名",
        agentId: k.agentId,
      });
      await reload();
      toast.success(`新 Key 已签发，旧 Key ${GRACE_HOURS} 小时后失效`);
      document
        .getElementById("issued-key")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (error) {
      toast.error(`轮换失败：${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  }

  async function revokeKey(id: string) {
    setBusy(id);
    try {
      await fetchJson(`/api/keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (issued?.id === id) setIssued(null);
      await reload();
      toast.success("Key 已吊销");
    } catch (error) {
      toast.error(`吊销失败：${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  }

  async function copyIssued() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.plaintext);
      toast.success("已复制到剪贴板");
    } catch (error) {
      toast.error(`复制失败：${errorText(error)}`);
    }
  }

  const now = Date.now();
  const oldKeys = rotatedOldKeys(keys);
  const issuedAgent = issued?.agentId ? agentById.get(issued.agentId) : undefined;

  return (
    <SpacePage
      side="developer"
      title="API Key 与签名密钥"
      subtitle="账号级的调用凭证。具体智能体的调用代码、在线试调、Webhook 地址和投递记录在它的构建页「接入」阶段。"
    >
      <Banner icon={<Info />}>
        Key 只能放在你的后端服务里，不要写进网页或 App；明文只在签发时显示一次。
        {limits.perKeyPerMinute > 0 ? (
          <>
            平台默认每个 Key 每分钟 <b>{limits.perKeyPerMinute}</b> 次
          </>
        ) : (
          "平台默认每个 Key 每分钟不限次数"
        )}
        {limits.perAgentPerMinute > 0 && (
          <>
            、每个智能体所有 Key 合计每分钟 <b>{limits.perAgentPerMinute}</b> 次
          </>
        )}
        ，超出返回 <code className="font-mono">429</code> 并带 Retry-After；用同一个 Idempotency-Key
        重试已受理的请求不计入。
      </Banner>

      {/* 签发 */}
      <section aria-label="签发新 Key" className="rounded-2xl border border-border bg-card">
        <CardHead title="签发新 Key" meta="签发后可随时改限额、轮换或吊销" />
        <form
          noValidate
          className="px-[22px] pb-5 max-md:px-4"
          onSubmit={(e) => {
            e.preventDefault();
            void issueKey();
          }}
        >
          <div className="grid items-end gap-3 lg:grid-cols-[minmax(0,1.5fr)_150px_170px_minmax(0,1.2fr)_auto] max-lg:grid-cols-2 max-sm:grid-cols-1">
            <label className="flex flex-col gap-1.5 max-lg:col-span-2 max-sm:col-span-1">
              <span className="text-[13px] text-muted-foreground">用途备注</span>
              <Input
                ref={nameRef}
                value={keyName}
                onChange={(e) => {
                  setKeyName(e.target.value);
                  if (errField === "name") setErrField(null);
                }}
                placeholder="例如：报销系统对接（生产）"
                aria-label="用途备注"
                aria-invalid={errField === "name" || undefined}
                aria-describedby="issue-key-msg"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] text-muted-foreground">每分钟上限</span>
              <Input
                ref={rpmRef}
                inputMode="numeric"
                value={keyLimit}
                onChange={(e) => {
                  setKeyLimit(e.target.value);
                  if (errField === "rpm") setErrField(null);
                }}
                aria-invalid={errField === "rpm" || undefined}
                aria-describedby="issue-key-msg"
                placeholder={
                  limits.perKeyPerMinute > 0 ? `默认 ${limits.perKeyPerMinute}` : "默认不限"
                }
                aria-label="每分钟调用上限"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] text-muted-foreground">有效期</span>
              <NativeSelect
                value={keyDays}
                onChange={(e) => setKeyDays(e.target.value)}
                aria-label="有效期"
              >
                <option value="">不过期</option>
                <option value="30">30 天</option>
                <option value="90">90 天</option>
                <option value="365">1 年</option>
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1.5 max-lg:col-span-2 max-sm:col-span-1">
              <span className="text-[13px] text-muted-foreground">限定智能体</span>
              <NativeSelect
                value={keyAgent}
                onChange={(e) => setKeyAgent(e.target.value)}
                aria-label="限定智能体"
                disabled={!agentsLoaded || Boolean(agentsError)}
              >
                <option value="">不限（可调用我能用的全部智能体）</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    仅 {a.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <Button
              type="submit"
              className="max-lg:col-span-2 max-sm:col-span-1"
              disabled={busy !== null}
            >
              <KeyRound />
              {busy === "issue" ? "签发中…" : "签发 Key"}
            </Button>
          </div>
          <p
            id="issue-key-msg"
            aria-live="polite"
            className={cn(
              "mt-2 min-h-[18px] text-xs",
              formError ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {formError || rpmHint(rpmMax)}
          </p>
        </form>
        {issued && (
          <div
            id="issued-key"
            className="mx-[22px] mb-[18px] rounded-[14px] border border-[#D3E2D6] bg-[#F3F7F3] px-4 py-3.5 max-md:mx-4"
          >
            <p className="flex items-center gap-2 font-semibold text-success-text">
              <Check className="size-[18px]" />
              已签发「{issued.name}」
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              这是唯一一次显示完整 Key。复制后放进你的服务端配置，关掉后只能看到末尾 4
              位（列表里显示为 <code className="font-mono text-foreground">{issued.hint}</code>）。
            </p>
            <div className="my-2.5 flex flex-wrap items-center gap-3 rounded-xl bg-[#1F1E1C] px-4 py-3 font-mono text-sm text-[#F2EFE7]">
              <code className="min-w-0 flex-1 basis-60 break-all">{issued.plaintext}</code>
              <Button size="sm" variant="outline" onClick={() => void copyIssued()}>
                <Copy className="size-[15px]" />
                复制
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                onClick={() => {
                  setIssued(null);
                  toast.success("明文已隐藏，之后只显示末尾 4 位");
                }}
              >
                我已保存
              </Button>
              {issued.agentId && (
                <Link
                  className="text-sm underline decoration-[#C9C4B8] underline-offset-[3px]"
                  href={agentHref({ id: issued.agentId, stage: "access" })}
                >
                  去「{issuedAgent?.name ?? issued.agentId}」的接入页试调
                </Link>
              )}
            </div>
          </div>
        )}
      </section>

      {/* 我的 Key */}
      <section aria-label="我的 Key" className="mt-4 rounded-2xl border border-border bg-card">
        <CardHead
          title="我的 Key"
          meta={keysLoaded && !keysError ? `${keys.length} 个` : undefined}
        />
        {!keysLoaded ? (
          <div className="px-[22px] pb-[22px] max-md:px-4" aria-busy>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-4 border-b border-line-soft py-3.5">
                <Skeleton className="h-3.5 w-48" />
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3.5 flex-1" />
              </div>
            ))}
            <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              正在载入 Key…
            </p>
          </div>
        ) : keysError ? (
          <EmptyState
            title="Key 列表没有载入"
            action={
              <Button variant="outline" onClick={() => void retry()}>
                <RefreshCw />
                重试
              </Button>
            }
          >
            {keysError}。已签发的 Key 不受影响，仍可正常调用。
          </EmptyState>
        ) : keys.length === 0 ? (
          <EmptyState
            title="还没有 Key"
            action={
              <Button variant="outline" onClick={() => nameRef.current?.focus()}>
                <Plus />
                签发 Key
              </Button>
            }
          >
            在上方签发第一个 Key，就能在你的服务里调用智能体。
          </EmptyState>
        ) : (
          <div className={tb.wrap}>
            <table className={cn(tb.table, "min-w-[980px]")}>
              <caption className="sr-only">我的 API Key</caption>
              <thead>
                <tr>
                  <th scope="col" className={cn(tb.th, tb.first)}>
                    名称
                  </th>
                  <th scope="col" className={tb.th}>
                    限定智能体
                  </th>
                  <th scope="col" className={tb.th}>
                    有效期
                  </th>
                  <th scope="col" className={tb.th}>
                    最近使用
                  </th>
                  <th scope="col" className={tb.th}>
                    每分钟限额
                  </th>
                  <th scope="col" className={tb.th}>
                    本月积分 / 月度上限
                  </th>
                  <th scope="col" className={cn(tb.th, tb.last, tb.right)}>
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const exp = keyExpiry(k.expiresAt, now);
                  const isOld = oldKeys.has(k.id);
                  const agent = k.agentId ? agentById.get(k.agentId) : undefined;
                  return (
                    <tr key={k.id} className={cn(issued?.id === k.id && "[&>td]:bg-fresh")}>
                      <td className={cn(tb.td, tb.first)}>
                        <div className="font-semibold">
                          {k.name || "（未命名）"}
                          {isOld && <span className="text-muted-foreground">（旧）</span>}
                        </div>
                        <div
                          className="font-mono text-xs text-muted-foreground"
                          title={`ID ${k.id}`}
                        >
                          {keyLabel(k)}
                        </div>
                      </td>
                      <td className={tb.td}>
                        {k.agentId ? (
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            <AgentAvatar id={k.agentId} icon={agent?.icon} size={22} />仅{" "}
                            {agent?.name ?? k.agentId}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">不限</span>
                        )}
                      </td>
                      <td className={cn(tb.td, "whitespace-nowrap")}>
                        {exp.kind === "never" ? (
                          <span className="text-muted-foreground">{exp.text}</span>
                        ) : exp.kind === "expired" ? (
                          <Badge variant="destructive">{exp.text}</Badge>
                        ) : exp.kind === "soon" ? (
                          <Badge variant="warning">
                            <Clock />
                            {isOld ? `轮换后旧 Key，${exp.text.replace("过期", "失效")}` : exp.text}
                          </Badge>
                        ) : (
                          exp.text
                        )}
                      </td>
                      <td className={cn(tb.td, tb.num)}>
                        {k.lastUsedAt ? (
                          <span title={formatTime(k.lastUsedAt, now)}>
                            {shortTime(k.lastUsedAt, now)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">从未使用</span>
                        )}
                      </td>
                      <td className={tb.td}>
                        <KeyRateLimit
                          keyId={k.id}
                          value={k.rateLimitPerMinute}
                          platform={limits.perKeyPerMinute}
                          onSaved={reload}
                        />
                      </td>
                      <td className={tb.td}>
                        <KeyMonthlyLimit
                          keyId={k.id}
                          limitMicro={k.monthlyLimitMicroCredits}
                          usedMicro={k.monthUsedMicroCredits ?? "0"}
                          onSaved={reload}
                        />
                      </td>
                      <td className={cn(tb.td, tb.last, "text-right whitespace-nowrap")}>
                        {exp.kind !== "expired" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() =>
                              confirm.ask({
                                title: "轮换这个 Key？",
                                description: `会立即签发一个新 Key 给「${k.name || "未命名"}」，新 Key 沿用备注、限定智能体和限额。旧 Key ${keyLabel(k)} 在 ${GRACE_HOURS} 小时后失效，请在这之前把调用方换成新 Key。`,
                                confirmLabel: "立即轮换",
                                onConfirm: () => rotateKey(k),
                              })
                            }
                          >
                            <RefreshCw className="size-[15px]" />
                            轮换
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          disabled={busy !== null}
                          onClick={() =>
                            confirm.ask({
                              title: "吊销这个 Key？",
                              description: `「${k.name || "未命名"}」（${keyLabel(k)}）会立即失效，正在用它的调用方马上会收到 401，不能撤销。`,
                              confirmLabel: "吊销",
                              destructive: true,
                              onConfirm: () => revokeKey(k.id),
                            })
                          }
                        >
                          <Trash2 className="size-[15px]" />
                          吊销
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <WebhookSecretCard />
        <section
          aria-label="按智能体查看调用文档"
          className="rounded-2xl border border-border bg-card"
        >
          <CardHead title="按智能体查看调用文档" />
          <div className="px-[22px] pb-3 max-md:px-4">
            <p className="mb-1.5 text-sm text-muted-foreground">
              调用代码（curl / Python / Node）、OpenAPI、在线试调和 Webhook
              投递记录都在各自的「接入」阶段。
            </p>
            {!agentsLoaded ? (
              <div className="space-y-3 py-3" aria-busy>
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : agentsError ? (
              <div className="flex flex-wrap items-center gap-2 py-3 text-sm text-destructive">
                智能体列表没有载入：{agentsError}
                <Button size="sm" variant="outline" onClick={() => void retry()}>
                  重试
                </Button>
              </div>
            ) : agents.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                还没有可调用的智能体，先去{" "}
                <Link
                  className="underline underline-offset-[3px]"
                  href={agentHref({ isNew: true })}
                >
                  新建一个
                </Link>
                。
              </p>
            ) : (
              <ul>
                {agents.map((a) => (
                  <li key={a.id} className="border-b border-line-soft last:border-0">
                    <Link
                      href={agentHref({ id: a.id, stage: "access" })}
                      className="group flex min-h-11 items-center gap-3 px-1 py-3"
                    >
                      <AgentAvatar id={a.id} icon={a.icon} size={34} />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{a.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {accessStatusText(a)}
                        </span>
                      </span>
                      <span className="ml-auto flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground group-hover:text-foreground">
                        接入
                        <ChevronRight className="size-[15px]" />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
      {confirm.dialog}
    </SpacePage>
  );
}
