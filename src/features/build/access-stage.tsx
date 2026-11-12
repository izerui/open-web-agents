"use client";

// 接入阶段(承接原接入中心的单智能体部分):调用徽标、版本与 OpenAPI 文档、签发限定本智能体的 Key(内联)、
// 调用代码(curl / Python / Node,示例入参按 inputSchema 生成并校验)、在线试调(A16)、Webhook。

import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { keyExpiry } from "@/features/integration/key-display";
import { KeyMonthlyLimit } from "@/features/integration/key-monthly-limit";
import { KeyRateLimit } from "@/features/integration/key-rate-limit";
import { type SnippetLang, buildSnippets, sampleInput } from "@/features/integration/snippets";
import { WebhookDeliveries } from "@/features/integration/webhook-deliveries";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatTime } from "@/lib/format-time";
import { useMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import {
  Activity,
  Braces,
  Check,
  ChevronRight,
  KeyRound,
  Loader2,
  Lock,
  Play,
  SquareTerminal,
  TriangleAlert,
  Webhook,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { Stage } from "./build-model";
import { Banner, Block, CodeBlock, CopyButton, Field, StageTitle, Tag, TextButton } from "./ui";
import type { KeyRecord, VersionMeta } from "./use-build-data";

const fmt = (ms?: number) => (ms ? formatTime(ms) : "从未使用");

interface Endpoint {
  method: string;
  path: string;
  summary: string;
}

export function AccessStage({
  agentId,
  agentName,
  publishedVersion,
  hasUnpublishedChanges,
  changeCount,
  inputSchema,
  outputSchema,
  versions,
  keys,
  rateLimits,
  canManageWebhook,
  webhookUrl,
  onKeysChanged,
  goStage,
  openWebhookSection,
}: {
  agentId: string | null;
  agentName: string;
  publishedVersion: number | null;
  hasUnpublishedChanges: boolean;
  changeCount: number | null;
  /** 调用方默认拿到的契约(已发布版本的;从未发布则是草稿的) */
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  versions: VersionMeta[] | null;
  keys: KeyRecord[];
  rateLimits: { perKeyPerMinute: number; perAgentPerMinute: number };
  canManageWebhook: boolean;
  webhookUrl?: string;
  onKeysChanged: () => void;
  goStage: (s: Stage) => void;
  openWebhookSection: () => void;
}) {
  const { me } = useMe();
  const confirm = useConfirm();
  const [oaOpen, setOaOpen] = useState(false);
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [lang, setLang] = useState<SnippetLang>("curl");
  const [keyName, setKeyName] = useState("");
  const [keyLimit, setKeyLimit] = useState("");
  const [keyDays, setKeyDays] = useState("90");
  const [keyFormOpen, setKeyFormOpen] = useState(false);
  const [issued, setIssued] = useState<{ id: string; plaintext: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const id = agentId ?? "";
  const structIn = Boolean(inputSchema);
  const structOut = Boolean(outputSchema);
  const snippets = useMemo(
    () =>
      buildSnippets({
        origin: typeof window === "undefined" ? "" : window.location.origin,
        agentId: id,
        inputSchema,
        hasOutputSchema: structOut,
      }),
    [id, inputSchema, structOut],
  );

  useEffect(() => {
    if (!oaOpen || endpoints || !agentId) return;
    void fetchJson<{
      paths?: Record<string, Record<string, { summary?: string; description?: string }>>;
    }>(`/api/agents/${encodeURIComponent(agentId)}/openapi.json`).then(
      (doc) =>
        setEndpoints(
          Object.entries(doc.paths ?? {}).flatMap(([path, ops]) =>
            Object.entries(ops).map(([method, op]) => ({
              method: method.toUpperCase(),
              path,
              summary: op.summary ?? op.description ?? "",
            })),
          ),
        ),
      (e) => {
        setEndpoints([]);
        toast.error(`OpenAPI 文档读取失败：${errorText(e)}`);
      },
    );
  }, [oaOpen, endpoints, agentId]);

  if (!agentId) {
    return (
      <div>
        <StageTitle title="接入" />
        <Banner>填好名称和提示词、草稿自动建好后就能签 Key、看调用代码。</Banner>
      </div>
    );
  }

  async function issueKey() {
    if (busy) return;
    if (!keyName.trim()) return toast.error("请填写用途备注，方便以后认出这个 Key");
    setBusy("issue");
    try {
      const data = await fetchJson<{ plaintext?: string; key?: { id?: string } }>("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: keyName.trim(),
          agentId,
          rateLimitPerMinute: keyLimit.trim() ? Number(keyLimit) : undefined,
          expiresInDays: keyDays ? Number(keyDays) : undefined,
        }),
      });
      if (!data.plaintext || !data.key?.id) throw new Error("接口没有返回新密钥");
      setIssued({ id: data.key.id, plaintext: data.plaintext });
      setKeyName("");
      setKeyLimit("");
      setKeyFormOpen(false);
      onKeysChanged();
    } catch (e) {
      toast.error(`签发失败：${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const showForm = !issued && (keyFormOpen || keys.length === 0);
  const webhookMask = me?.user?.webhookSecretMask;

  return (
    <div>
      <StageTitle
        title="接入"
        desc={
          <>
            <div className="mb-1.5">从你的系统里调用这个智能体。</div>
            <div className="flex flex-wrap gap-1.5">
              <Tag tone={publishedVersion !== null ? "ok" : "warn"}>
                {publishedVersion !== null ? `已发布 v${publishedVersion}` : "未发布，调用使用草稿"}
              </Tag>
              <Tag>{structIn ? "结构化入参" : "文本入参"}</Tag>
              <Tag>{structOut ? "结构化结果 structured" : "文本结果 text"}</Tag>
            </div>
          </>
        }
        right={
          <TextButton onClick={() => goStage("runs")}>
            <Activity />
            运行记录
          </TextButton>
        }
      />

      <Block
        icon={<Braces />}
        title="版本与文档"
        right={
          <TextButton aria-expanded={oaOpen} onClick={() => setOaOpen(!oaOpen)}>
            <ChevronRight className={cn("transition-transform", oaOpen && "rotate-90")} />
            OpenAPI 文档
          </TextButton>
        }
      >
        <p className="mt-1.5 mb-0 text-sm text-muted-foreground">
          {publishedVersion !== null ? (
            <>
              不传 version 时调用当前发布版 v{publishedVersion}
              ，发布新版本后自动切换；需要固定某一版时在请求体里加{" "}
              <span className="font-mono text-foreground">"version": {publishedVersion}</span>。
              {hasUnpublishedChanges &&
                `草稿里有${changeCount ? ` ${changeCount} 处` : ""}未发布的修改，不影响调用方。`}
            </>
          ) : (
            "还没发布：调用直接跑草稿，草稿一改调用方就受影响。对外稳定使用前，建议先发布一个版本。"
          )}
        </p>
        {oaOpen && (
          <div className="mt-2.5">
            <div className="overflow-hidden rounded-xl border border-border">
              {endpoints === null ? (
                <div className="px-3 py-2.5 text-sm text-muted-foreground">载入中…</div>
              ) : (
                endpoints.map((e) => (
                  <div
                    key={`${e.method} ${e.path}`}
                    className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-0.5 border-b border-line-soft px-3 py-2 text-[13px] last:border-0 md:grid-cols-[64px_minmax(0,320px)_minmax(0,1fr)]"
                  >
                    <span
                      className={cn(
                        "rounded-md py-0.5 text-center font-mono text-xs font-semibold",
                        e.method === "POST"
                          ? "bg-[#E6EEF6] text-[#2B5278]"
                          : "bg-success-soft text-success-text",
                      )}
                    >
                      {e.method}
                    </span>
                    <span className="font-mono text-[13px] [overflow-wrap:anywhere]">{e.path}</span>
                    <span className="text-muted-foreground max-md:col-start-2">{e.summary}</span>
                  </div>
                ))
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
              原文：
              <a
                className="font-mono underline"
                href={`/api/agents/${encodeURIComponent(agentId)}/openapi.json`}
                target="_blank"
                rel="noreferrer"
              >
                /api/agents/{agentId}/openapi.json
              </a>
              <CopyButton
                text={`${typeof window === "undefined" ? "" : window.location.origin}/api/agents/${encodeURIComponent(agentId)}/openapi.json`}
                label="复制地址"
                done="OpenAPI 地址已复制"
              />
            </div>
          </div>
        )}
      </Block>

      <Block
        icon={<KeyRound />}
        title="限定本智能体的 API Key"
        right={
          <Link href="/developer/keys" className="text-[13px] underline">
            管理全部 Key 与签名密钥
          </Link>
        }
      >
        <p className="mt-1 mb-0 text-[13px] text-muted-foreground">
          Key 只在后端用，明文只显示一次。
          {rateLimits.perKeyPerMinute > 0
            ? `平台默认每 Key 每分钟 ${rateLimits.perKeyPerMinute} 次`
            : "平台默认每 Key 不限次数"}
          {rateLimits.perAgentPerMinute > 0 && `、每智能体合计 ${rateLimits.perAgentPerMinute} 次`}
          ，超出返回 429。
        </p>
        {issued && (
          <>
            <Banner tone="warn" icon={<TriangleAlert />} className="mt-3 mb-0">
              <b>明文只显示这一次。</b>关掉后只能轮换，不能再查看。
            </Banner>
            <div className="my-3 flex flex-wrap items-center gap-3 rounded-xl bg-[#1F1E1C] px-4 py-3.5 font-mono text-sm text-[#F2EFE7]">
              <span className="min-w-0 flex-1 break-all">{issued.plaintext}</span>
              <CopyButton
                text={issued.plaintext}
                done="Key 已复制"
                className="bg-card text-foreground hover:bg-[#F2F0EA]"
              />
              <Button
                size="sm"
                variant="success"
                onClick={() => {
                  setIssued(null);
                  toast.success("明文已收起，之后只能轮换，不能再查看");
                }}
              >
                我已保存
              </Button>
            </div>
          </>
        )}
        {showForm && (
          <>
            <div className="mt-3 grid gap-x-3 md:grid-cols-[1.5fr_0.8fr_1fr]">
              <Field label="用途备注" htmlFor="key-name">
                <Input
                  id="key-name"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder="例如 订单系统"
                />
              </Field>
              <Field label="每分钟上限" htmlFor="key-rpm">
                <Input
                  id="key-rpm"
                  type="number"
                  min={1}
                  value={keyLimit}
                  onChange={(e) => setKeyLimit(e.target.value)}
                  placeholder={`默认 ${rateLimits.perKeyPerMinute || "不限"}`}
                />
              </Field>
              <Field label="有效期" htmlFor="key-days">
                <NativeSelect
                  id="key-days"
                  value={keyDays}
                  onChange={(e) => setKeyDays(e.target.value)}
                >
                  <option value="90">90 天</option>
                  <option value="">不过期</option>
                  <option value="30">30 天</option>
                  <option value="365">1 年</option>
                </NativeSelect>
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={busy !== null} onClick={() => void issueKey()}>
                {busy === "issue" ? <Loader2 className="animate-spin" /> : <KeyRound />}
                签发 Key（仅 {agentName || agentId}）
              </Button>
              {keys.length > 0 && (
                <Button variant="outline" onClick={() => setKeyFormOpen(false)}>
                  取消
                </Button>
              )}
              <span className="text-[13px] text-muted-foreground">
                月度积分上限可以在下面的列表里逐个设置
              </span>
            </div>
          </>
        )}
        {keys.length > 0 && (
          <div className="mt-3 overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line-soft text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-normal">备注</th>
                  <th className="px-3 py-2 font-normal">Key</th>
                  <th className="px-3 py-2 font-normal">有效期</th>
                  <th className="px-3 py-2 font-normal">每分钟</th>
                  <th className="px-3 py-2 font-normal">本月积分</th>
                  <th className="px-3 py-2 font-normal">最近使用</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const exp = keyExpiry(k.expiresAt, Date.now());
                  return (
                    <tr key={k.id} className="border-b border-line-soft last:border-0">
                      <td className="px-3 py-2">{k.name || "（未命名）"}</td>
                      <td
                        className="px-3 py-2 font-mono text-[13px] whitespace-nowrap text-muted-foreground"
                        title={
                          k.keyHint ? "明文只在签发时显示一次" : "旧 Key 没有记录尾号，显示 Key ID"
                        }
                      >
                        {k.keyHint || k.id}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 whitespace-nowrap",
                          exp.kind !== "date" && exp.kind !== "never" && "text-destructive",
                        )}
                      >
                        {exp.text}
                      </td>
                      <td className="px-3 py-2">
                        <KeyRateLimit
                          keyId={k.id}
                          value={k.rateLimitPerMinute}
                          platform={rateLimits.perKeyPerMinute}
                          onSaved={onKeysChanged}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <KeyMonthlyLimit
                          keyId={k.id}
                          limitMicro={k.monthlyLimitMicroCredits}
                          usedMicro={k.monthUsedMicroCredits ?? "0"}
                          onSaved={onKeysChanged}
                        />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {fmt(k.lastUsedAt)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <TextButton
                          disabled={busy !== null || exp.kind === "expired"}
                          onClick={() =>
                            confirm.ask({
                              title: `轮换「${k.name || "未命名"}」？`,
                              description:
                                "立即签发一把新 Key，旧 Key 在 24 小时后失效。请在此期间把对接方换成新 Key。",
                              confirmLabel: "轮换",
                              onConfirm: async () => {
                                try {
                                  const d = await fetchJson<{
                                    plaintext?: string;
                                    key?: { id?: string };
                                  }>(`/api/keys/${encodeURIComponent(k.id)}/rotate`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ graceHours: 24 }),
                                  });
                                  if (!d.plaintext || !d.key?.id)
                                    throw new Error("接口没有返回新密钥");
                                  setIssued({ id: d.key.id, plaintext: d.plaintext });
                                  onKeysChanged();
                                  toast.success("已签发新 Key，旧 Key 24 小时后失效");
                                } catch (e) {
                                  toast.error(`轮换失败：${errorText(e)}`);
                                }
                              },
                            })
                          }
                        >
                          轮换
                        </TextButton>
                        <TextButton
                          className="text-destructive"
                          disabled={busy !== null}
                          onClick={() =>
                            confirm.ask({
                              title: `吊销「${k.name || "未命名"}」？`,
                              description: "正在使用它的系统会立即调用失败，不能撤销。",
                              confirmLabel: "吊销",
                              destructive: true,
                              onConfirm: async () => {
                                try {
                                  await fetchJson(`/api/keys?id=${encodeURIComponent(k.id)}`, {
                                    method: "DELETE",
                                  });
                                  if (issued?.id === k.id) setIssued(null);
                                  onKeysChanged();
                                  toast.success("API Key 已吊销");
                                } catch (e) {
                                  toast.error(`吊销失败：${errorText(e)}`);
                                }
                              },
                            })
                          }
                        >
                          吊销
                        </TextButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {keys.length > 0 && !showForm && !issued && (
          <TextButton className="mt-2" onClick={() => setKeyFormOpen(true)}>
            <KeyRound />
            再签一个
          </TextButton>
        )}
      </Block>

      <Block
        icon={<SquareTerminal />}
        title="调用代码"
        right={
          <Tag tone={snippets.sample.valid ? "ok" : "warn"}>
            {structIn
              ? snippets.sample.valid
                ? "示例入参按 inputSchema 生成，已通过 schema 校验"
                : "示例入参需要按实际填写"
              : "文本入参"}
          </Tag>
        }
      >
        {!snippets.sample.valid && (
          <ul className="mt-2 mb-0 list-disc pl-5 text-[13px] text-warning-text">
            {snippets.sample.issues.slice(0, 5).map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        <div className="mt-2 mb-2 flex items-center gap-1 border-b border-line-soft">
          {(
            [
              ["curl", "curl"],
              ["python", "Python"],
              ["node", "Node"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={lang === k}
              onClick={() => setLang(k)}
              className={cn(
                "-mb-px h-10 border-b-2 border-transparent px-3.5 text-sm text-muted-foreground",
                lang === k && "border-foreground font-medium text-foreground",
              )}
            >
              {label}
            </button>
          ))}
          <CopyButton className="ml-auto" text={snippets[lang]} done="代码已复制" />
        </div>
        <CodeBlock className="max-h-[300px]">{snippets[lang]}</CodeBlock>
      </Block>

      <TryPanel
        agentId={agentId}
        publishedVersion={publishedVersion}
        versions={versions}
        inputSchema={inputSchema}
        goStage={goStage}
      />

      <Block
        icon={<Webhook />}
        title="Webhook"
        right={
          <>
            <Tag tone={webhookMask ? "ok" : "warn"}>
              {webhookMask
                ? `签名密钥已配置 ${webhookMask}（账号级，所有智能体共用）`
                : "账号还没有配置签名密钥"}
            </Tag>
            <Link href="/developer/keys" className="text-[13px] underline">
              管理签名密钥
            </Link>
          </>
        }
      >
        {canManageWebhook ? (
          <>
            <p className="mt-2 mb-2.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">
              回调地址{" "}
              {webhookUrl ? (
                <span className="font-mono text-foreground">{webhookUrl}</span>
              ) : (
                <b>尚未配置回调地址</b>
              )}
              <button type="button" className="mx-2 underline" onClick={openWebhookSection}>
                {webhookUrl ? "修改" : "配置回调地址"}
              </button>
              签名头 X-OWA-Signature、X-OWA-Timestamp
            </p>
            <WebhookDeliveries key={agentId} agentId={agentId} webhookUrl={webhookUrl} />
          </>
        ) : (
          <Banner icon={<Lock />} className="mt-2 mb-0">
            回调地址与投递记录由智能体所有者管理。
          </Banner>
        )}
      </Block>
      {confirm.dialog}
    </div>
  );
}

/** 在线试调(A16):用登录态真实调用一次(POST /api/agents/[id]/try),轮询结果 */
function TryPanel({
  agentId,
  publishedVersion,
  versions,
  inputSchema,
  goStage,
}: {
  agentId: string;
  publishedVersion: number | null;
  versions: VersionMeta[] | null;
  inputSchema?: Record<string, unknown> | null;
  goStage: (s: Stage) => void;
}) {
  const example = () => JSON.stringify({ input: sampleInput(inputSchema).value }, null, 2);
  const [body, setBody] = useState(example);
  const [version, setVersion] = useState("");
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "running"; taskId?: string; started: number }
    | { kind: "done"; code: string; tone: "ok" | "bad" | "warn"; out: string; taskId?: string }
  >({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function run() {
    let parsed: Record<string, unknown>;
    try {
      const v = JSON.parse(body) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("请求体须为 JSON 对象");
      parsed = v as Record<string, unknown>;
    } catch (e) {
      setState({ kind: "done", code: "请求体不是合法 JSON", tone: "bad", out: errorText(e) });
      return;
    }
    if (version) parsed.version = Number(version);
    const started = Date.now();
    setState({ kind: "running", started });
    const base = `/api/agents/${encodeURIComponent(agentId)}/try`;
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    }).catch(() => null);
    if (!res) {
      setState({ kind: "done", code: "网络错误", tone: "bad", out: "" });
      return;
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      setState({
        kind: "done",
        code: `${res.status} ${res.status === 400 ? "入参不符合契约" : "调用被拒绝"}`,
        tone: "bad",
        out: JSON.stringify(data, null, 2),
      });
      return;
    }
    const taskId = String(data.taskId ?? "");
    setState({ kind: "running", taskId, started });
    for (let i = 0; i < 600 && alive.current; i++) {
      await new Promise((r) => setTimeout(r, i < 5 ? 800 : 2000));
      const r = await fetch(`${base}?runId=${encodeURIComponent(taskId)}`, {
        cache: "no-store",
      }).catch(() => null);
      if (!r) continue;
      const result = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) {
        setState({
          kind: "done",
          code: `${r.status}`,
          tone: "bad",
          out: JSON.stringify(result, null, 2),
          taskId,
        });
        return;
      }
      if (result.done) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        setState({
          kind: "done",
          code: `${String(result.status)}，${secs}s`,
          tone: result.status === "success" ? "ok" : "bad",
          out: JSON.stringify({ taskId, sessionId: data.sessionId, ...result }, null, 2),
          taskId,
        });
        return;
      }
    }
  }

  const running = state.kind === "running";
  const taskId = state.kind === "idle" ? undefined : state.taskId;
  return (
    <Block
      icon={<Play />}
      title="在线试调"
      right={
        <span className="text-[13px] text-muted-foreground">
          真实调用并计费，记在你名下；会话来源记为接口调用
        </span>
      }
    >
      <div className="mt-2.5 grid gap-3 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-2 text-[13px] text-muted-foreground">
            请求体
            <NativeSelect
              aria-label="调用版本"
              className="ml-auto h-8 w-[170px] text-[13px]"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            >
              <option value="">
                {publishedVersion !== null ? "最新发布版" : "草稿（未发布）"}
              </option>
              {(versions ?? []).map((v) => (
                <option key={v.version} value={String(v.version)}>
                  v{v.version}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Textarea
            aria-label="请求体"
            className="min-h-56 resize-y font-mono text-[13px]"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" disabled={running} onClick={() => void run()}>
              {running ? <Loader2 className="animate-spin" /> : <Play />}
              {running ? "调用中…" : "运行"}
            </Button>
            <TextButton onClick={() => setBody(example())}>恢复示例</TextButton>
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-1.5 flex h-8 items-center gap-2 text-[13px] text-muted-foreground">
            返回
            {state.kind === "running" && (
              <Tag tone="warn">
                <Loader2 className="animate-spin" />
                {taskId ? "202 运行中" : "提交中"}
              </Tag>
            )}
            {state.kind === "done" && (
              <Tag tone={state.tone}>
                {state.tone === "ok" && <Check />}
                {state.code}
              </Tag>
            )}
            {taskId && (
              <button
                type="button"
                className="ml-auto truncate underline"
                onClick={() => goStage("runs")}
              >
                {taskId} 在运行记录里看
              </button>
            )}
          </div>
          <CodeBlock className="h-[236px] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {state.kind === "done" ? (
              state.out
            ) : state.kind === "running" ? (
              <span className="text-[#A29D90]">{"// 已提交，正在等结果（每 2 秒查询一次）…"}</span>
            ) : (
              <span className="text-[#A29D90]">
                {"// 点「运行」后在这里看返回的 JSON 与 runId"}
              </span>
            )}
          </CodeBlock>
        </div>
      </div>
    </Block>
  );
}
