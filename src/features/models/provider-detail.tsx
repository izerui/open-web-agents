"use client";

import { useConfirm } from "@/components/confirm-dialog";
import { LoadError } from "@/components/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { AdminPage, TD, TH, TableCard } from "@/features/admin/admin-ui";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { CapabilityKind } from "@/lib/modules/capabilities/domain/catalog";
import { formatMarkupPercent } from "@/lib/modules/capabilities/domain/pricing";
import { ENDPOINT_PROTOCOLS } from "@/lib/modules/model-gateway/domain/provider";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check, ChevronLeft, Cpu, KeyRound, Pencil, Play, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ModelDialog } from "./model-dialog";
import {
  type AdminModel,
  type Impact,
  KIND_LABEL,
  KIND_ORDER,
  type ProviderView,
  priceRows,
} from "./model-shared";

interface ProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  message: string;
  /** 上游回报的模型名与填写的标识不一致时才有 */
  reportedModel?: string;
}

const LIST_HREF = "/admin/models?tab=providers";

function BackLink() {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={LIST_HREF}>
        <ChevronLeft />
        返回列表
      </Link>
    </Button>
  );
}

/** 提供者详情(/admin/models/providers/[id];原 /admin/providers/[id]) */
export function ProviderDetail({ id, initialTab }: { id: string; initialTab?: string }) {
  const [provider, setProvider] = useState<ProviderView | null>(null);
  const [models, setModels] = useState<AdminModel[]>([]);
  const [aliasProvider, setAliasProvider] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<CapabilityKind>(
    KIND_ORDER.includes(initialTab as CapabilityKind) ? (initialTab as CapabilityKind) : "llm",
  );
  const [editing, setEditing] = useState<{ model: AdminModel | null } | null>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    try {
      const [p, m, all] = await Promise.all([
        fetchJson<{ provider: ProviderView }>(`/api/admin/providers/${encodeURIComponent(id)}`),
        fetchJson<{ models: AdminModel[] }>("/api/admin/models"),
        fetchJson<{ aliases: { providerId: string } | null }>("/api/admin/providers").catch(() => ({
          aliases: null,
        })),
      ]);
      setProvider(p.provider);
      setModels(m.models.filter((x) => x.providerId === id));
      setAliasProvider(all.aliases?.providerId ?? null);
      setLoadError("");
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // 从模型总览点进来时带 #model-<id>:数据到了再滚过去
  useEffect(() => {
    if (!provider || typeof window === "undefined" || !window.location.hash) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "center" });
  }, [provider]);

  async function saveProvider(next: Partial<Pick<ProviderView, "name" | "enabled" | "endpoints">>) {
    if (!provider) return;
    await fetchJson(`/api/admin/providers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: provider.version,
        definition: {
          name: next.name ?? provider.name,
          enabled: next.enabled ?? provider.enabled,
          endpoints: next.endpoints ?? provider.endpoints,
        },
      }),
    });
    await load();
  }

  if (loadError && !provider) {
    return (
      <AdminPage title="模型提供者" back={<BackLink />}>
        <TableCard>
          <LoadError what="提供者" message={loadError} onRetryAction={() => void load()} />
        </TableCard>
      </AdminPage>
    );
  }
  if (!provider) {
    return (
      <AdminPage title="模型提供者" back={<BackLink />}>
        <p className="text-sm text-muted-foreground">正在加载…</p>
      </AdminPage>
    );
  }

  const kindModels = models.filter((m) => m.kind === tab);

  return (
    <AdminPage
      back={<BackLink />}
      title={
        <span className="flex items-center gap-3">
          <span
            aria-hidden
            className="grid size-[46px] shrink-0 place-items-center rounded-[14px] bg-band text-[#4D4A43]"
          >
            <Cpu className="size-[22px]" />
          </span>
          <span className="min-w-0 break-words">{provider.name}</span>
        </span>
      }
      subtitle={[
        `${models.length} 个模型`,
        provider.enabled ? "启用中" : "已停用",
        aliasProvider === provider.id ? "默认路由使用中" : null,
      ]
        .filter(Boolean)
        .join("，")}
    >
      {loadError && (
        <div className="mb-3">
          <LoadError
            compact
            what="最新数据"
            message={loadError}
            onRetryAction={() => void load()}
          />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <BasicCard
          provider={provider}
          onSave={async (name, enabled) => {
            if (provider.enabled && !enabled) {
              const impact = await fetchJson<Impact>(
                `/api/admin/providers/${encodeURIComponent(id)}/impact`,
              );
              confirm.ask({
                title: `停用「${provider.name}」?`,
                description: `其下所有模型都将不可用，影响 ${impact.agents} 个智能体${impact.aliases.length ? `;别名 ${impact.aliases.join("、")} 指向其下模型` : ""}。进行中的运行不受影响。`,
                confirmLabel: "停用",
                destructive: true,
                onConfirm: async () => {
                  await saveProvider({ name, enabled }).then(
                    () => toast.success("已停用"),
                    (err) => toast.error(errorText(err)),
                  );
                },
              });
              return;
            }
            await saveProvider({ name, enabled });
            toast.success("已保存");
          }}
        />
        <KeyCard provider={provider} onReplaced={load} />
      </div>

      <fieldset aria-label="模型类型" className="mt-[18px] mb-3.5 flex min-w-0 flex-wrap gap-2">
        {KIND_ORDER.map((k) => {
          const on = k === tab;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              onClick={() => setTab(k)}
              className={cn(
                "flex h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-sm outline-none hover:bg-[#F2F0EA] focus-visible:ring-2 focus-visible:ring-ring max-md:h-11",
                on && "border-primary bg-primary text-primary-foreground hover:bg-primary",
              )}
            >
              {KIND_LABEL[k]}
              <span className={cn("text-xs", on ? "text-white/75" : "text-muted-foreground")}>
                {models.filter((m) => m.kind === k).length}
              </span>
            </button>
          );
        })}
      </fieldset>

      <div className="space-y-4">
        <EndpointCard
          key={tab}
          provider={provider}
          kind={tab}
          models={kindModels}
          onSave={(endpoint) =>
            saveProvider({
              endpoints: { ...provider.endpoints, [tab]: endpoint ?? undefined },
            })
          }
        />
        <ModelTable
          kind={tab}
          models={kindModels}
          onAdd={() => setEditing({ model: null })}
          onEdit={(model) => setEditing({ model })}
        />
      </div>

      {editing && (
        <ModelDialog
          providerId={id}
          kind={editing.model?.kind ?? tab}
          model={editing.model}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {confirm.dialog}
    </AdminPage>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card px-5 py-[18px]", className)}>
      {children}
    </section>
  );
}

function BasicCard({
  provider,
  onSave,
}: {
  provider: ProviderView;
  onSave: (name: string, enabled: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(provider.name);
  const [enabled, setEnabled] = useState(provider.enabled);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setName(provider.name);
    setEnabled(provider.enabled);
  }, [provider]);
  const dirty = name.trim() !== provider.name || enabled !== provider.enabled;
  return (
    <Card>
      <h2 className="text-base font-semibold">基本信息</h2>
      <p className="mt-1 mb-3.5 text-xs text-muted-foreground">
        停用后，这个提供者的模型都不能再发起新运行。
      </p>
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError("");
          try {
            await onSave(name.trim(), enabled);
          } catch (err) {
            setError(errorText(err));
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-3">
          <label htmlFor="provider-name" className="text-sm text-muted-foreground">
            名称
          </label>
          <Input
            id="provider-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor="provider-enabled" className="text-sm text-muted-foreground">
            状态
          </label>
          <div className="flex min-h-10 items-center gap-2.5">
            <Switch
              id="provider-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              className="data-[state=checked]:bg-success"
            />
            <span className="text-sm">{enabled ? "启用" : "停用"}</span>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div>
          <Button type="submit" size="sm" variant="outline" disabled={saving || !dirty}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function KeyCard({ provider, onReplaced }: { provider: ProviderView; onReplaced: () => void }) {
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(!provider.hasKey);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Card>
      <h2 className="text-base font-semibold">API Key</h2>
      <p className="mt-1 mb-3.5 text-xs text-muted-foreground">
        加密保存，保存后不能查看、只能替换；不会出现在智能体、日志或提示词中。
      </p>
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-band text-[#4D4A43]"
        >
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          {provider.hasKey ? (
            <>
              <div className="truncate font-mono">{provider.keyHint}</div>
              <div className="text-xs text-muted-foreground">已配置，替换后立即生效</div>
            </>
          ) : (
            <Badge variant="warning">未配置</Badge>
          )}
        </div>
        {provider.hasKey && !editing && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            替换
          </Button>
        )}
      </div>
      {editing && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!key.trim()) return;
            setSaving(true);
            setError("");
            try {
              await fetchJson(`/api/admin/providers/${encodeURIComponent(provider.id)}/key`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ apiKey: key.trim() }),
              });
              setKey("");
              setEditing(false);
              toast.success(provider.hasKey ? "API Key 已替换" : "API Key 已保存");
              onReplaced();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          <Input
            type="password"
            autoComplete="new-password"
            aria-label="API Key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={provider.hasKey ? "输入新 Key 以替换" : "输入 API Key"}
          />
          <Button type="submit" size="sm" disabled={saving || !key.trim()}>
            {provider.hasKey ? "替换" : "保存"}
          </Button>
          {provider.hasKey && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setKey("");
                setError("");
              }}
            >
              取消
            </Button>
          )}
        </form>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </Card>
  );
}

function EndpointCard({
  provider,
  kind,
  models,
  onSave,
}: {
  provider: ProviderView;
  kind: CapabilityKind;
  models: AdminModel[];
  onSave: (endpoint: { protocol: string; baseUrl: string } | null) => Promise<void>;
}) {
  const current = provider.endpoints[kind];
  const protocols = ENDPOINT_PROTOCOLS[kind];
  const [protocol, setProtocol] = useState(current?.protocol ?? protocols[0] ?? "");
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? "");
  const [testModel, setTestModel] = useState(models[0]?.modelId ?? "");
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setProtocol(current?.protocol ?? protocols[0] ?? "");
    setBaseUrl(current?.baseUrl ?? "");
  }, [current, protocols]);

  return (
    <Card>
      <h2 className="mb-3 text-base font-semibold">{KIND_LABEL[kind]}接入地址</h2>
      <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)_auto] sm:items-end">
        <label className="grid gap-1.5 text-[13px] text-muted-foreground">
          协议
          <NativeSelect
            value={protocol}
            disabled={protocols.length === 1}
            onChange={(e) => setProtocol(e.target.value)}
          >
            {protocols.map((p) => (
              <option key={p} value={p}>
                {p === "anthropic"
                  ? "Anthropic"
                  : p === "openai-compatible"
                    ? "OpenAI 兼容"
                    : "自定义"}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="grid gap-1.5 text-[13px] text-muted-foreground">
          地址
          <Input
            value={baseUrl}
            className="font-mono text-[13px]"
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://"
          />
        </label>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onSave(baseUrl.trim() ? { protocol, baseUrl: baseUrl.trim() } : null);
              toast.success("接入地址已保存");
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          保存
        </Button>
      </div>

      {kind === "llm" ? (
        <div className="mt-4 border-t border-line-soft pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1.5 text-[13px] text-muted-foreground">
              测试用模型标识
              <Input
                value={testModel}
                list={`models-${provider.id}`}
                className="w-[280px] max-w-full font-mono text-[13px]"
                onChange={(e) => setTestModel(e.target.value)}
                placeholder="模型标识"
              />
              <datalist id={`models-${provider.id}`}>
                {models.map((m) => (
                  <option key={m.id} value={m.modelId} />
                ))}
              </datalist>
            </label>
            <Button
              variant="outline"
              disabled={busy || !testModel.trim()}
              onClick={async () => {
                setBusy(true);
                setProbe(null);
                setError("");
                try {
                  const r = await fetchJson<{ result: ProbeResult }>(
                    `/api/admin/providers/${encodeURIComponent(provider.id)}/test`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        modelId: testModel.trim(),
                        baseUrl: baseUrl.trim() || undefined,
                      }),
                    },
                  );
                  setProbe(r.result);
                } catch (err) {
                  setError(errorText(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Play className="size-3.5" />
              测试连接
            </Button>
            <span className="pb-2.5 text-xs text-muted-foreground">
              发一条很短的请求，会产生极少量费用
            </span>
          </div>
          {probe && (
            <p
              aria-live="polite"
              className={cn(
                "mt-3 flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[13px]",
                probe.ok
                  ? "bg-success-soft text-success-text"
                  : "bg-destructive-soft text-destructive",
              )}
            >
              {probe.ok ? <Check className="size-4" /> : <AlertTriangle className="size-4" />}
              <span className="min-w-0 break-words">
                {probe.ok
                  ? `连接成功：${testModel.trim()} 在 ${probe.latencyMs} ms 内返回了回复`
                  : `失败${probe.status ? `(HTTP ${probe.status})` : ""}:${probe.message}(${probe.latencyMs} ms)`}
              </span>
            </p>
          )}
          {probe?.ok && probe.reportedModel && (
            <p
              className="mt-2 rounded-xl bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text"
              data-testid="probe-model-mismatch"
            >
              {probe.message}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          该类型暂未接入运行时，配置用于价目展示与后续接入，不提供连接测试。
        </p>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </Card>
  );
}

function ModelTable({
  kind,
  models,
  onAdd,
  onEdit,
}: {
  kind: CapabilityKind;
  models: AdminModel[];
  onAdd: () => void;
  onEdit: (m: AdminModel) => void;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-[18px] pb-3">
        <h2 className="text-base font-semibold">{KIND_LABEL[kind]}模型</h2>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          售价 = 成本单价（元）× 100 积分 ×(1 + 加价）；每次保存生成新版本
        </p>
        <Button size="sm" onClick={onAdd}>
          <Plus />
          添加模型
        </Button>
      </div>
      {models.length === 0 ? (
        <p className="border-t border-line-soft py-10 text-center text-sm text-muted-foreground">
          还没有{KIND_LABEL[kind]}模型
        </p>
      ) : (
        <TableCard className="rounded-none border-0">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <caption className="sr-only">{KIND_LABEL[kind]}模型与价目</caption>
            <thead>
              <tr>
                {["名称 / 标识", "成本单价（元）", "加价", "售价（积分）", "状态", "版本"].map(
                  (h) => (
                    <th key={h} scope="col" className={TH}>
                      {h}
                    </th>
                  ),
                )}
                <th className={TH}>
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const rows = priceRows(m);
                const free = m.rates.length > 0 && m.rates.every((r) => r.microCredits === "0");
                const inexact = rows.some((r) => !r.exact);
                return (
                  <tr key={m.id} id={`model-${m.id}`} className="target:bg-warning-soft">
                    <td className={TD}>
                      <div className="font-semibold">{m.name}</div>
                      <div className="font-mono text-xs break-all text-muted-foreground">
                        {m.modelId}
                      </div>
                      {inexact && <div className="text-xs text-warning-text">旧价目单位非标准</div>}
                    </td>
                    <td className={cn(TD, "text-[13px] leading-6 whitespace-nowrap")}>
                      {rows.map((r) => (
                        <div key={r.meter}>
                          {r.label}：{r.costYuan ?? "—"}
                        </div>
                      ))}
                    </td>
                    <td className={TD}>{formatMarkupPercent(m.markupBp ?? 0)}%</td>
                    <td className={cn(TD, "text-[13px] leading-6 whitespace-nowrap")}>
                      {rows.map((r) => (
                        <div key={r.meter}>
                          {r.label}：<span className="font-medium">{r.saleCredits ?? "—"}</span>
                        </div>
                      ))}
                    </td>
                    <td className={cn(TD, "whitespace-nowrap")}>
                      <div className="flex flex-wrap gap-1">
                        {m.enabled ? <Badge variant="success">启用</Badge> : <Badge>停用</Badge>}
                        {free && <Badge variant="outline">未定价</Badge>}
                      </div>
                    </td>
                    <td className={TD}>v{m.version}</td>
                    <td className={cn(TD, "text-right")}>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`编辑 ${m.name}`}
                        onClick={() => onEdit(m)}
                      >
                        <Pencil className="size-3.5" />
                        编辑
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableCard>
      )}
    </section>
  );
}
