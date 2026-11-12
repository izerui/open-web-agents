"use client";

import { LoadError } from "@/components/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import {
  type AdminModel,
  type AliasMapView,
  KIND_LABEL,
  KIND_ORDER,
  type ProviderView,
  priceRows,
} from "@/features/models/model-shared";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { CapabilityKind } from "@/lib/modules/capabilities/domain/catalog";
import { formatMarkupPercent } from "@/lib/modules/capabilities/domain/pricing";
import { MODEL_ALIASES } from "@/lib/shared";
import { cn } from "@/lib/utils";
import { ChevronRight, Cpu, Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AdminPage,
  AdminTabs,
  EmptyState,
  Segmented,
  TD,
  TH,
  TableCard,
  useTabParam,
} from "./admin-ui";

const TABS = [
  { value: "providers", label: "提供者" },
  { value: "models", label: "模型总览" },
  { value: "routing", label: "默认路由" },
] as const;
type Tab = (typeof TABS)[number]["value"];

export const PROTOCOL_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI 兼容",
  custom: "自定义",
};

export function providerHref(id: string, kind?: string) {
  return `/admin/models/providers/${encodeURIComponent(id)}${kind ? `?tab=${kind}` : ""}`;
}

/**
 * 平台管理 · 模型与提供者（原 /admin/providers、/admin/models 与默认别名路由三处合一）。
 * 提供者详情在 /admin/models/providers/[id]。
 */
export function ModelsPage() {
  const [tab, setTab] = useTabParam<Tab>(
    TABS.map((t) => t.value),
    "providers",
  );
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [aliases, setAliases] = useState<AliasMapView | null>(null);
  const [models, setModels] = useState<AdminModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, m] = await Promise.all([
        fetchJson<{ providers: ProviderView[]; aliases: AliasMapView | null }>(
          "/api/admin/providers",
        ),
        fetchJson<{ models: AdminModel[] }>("/api/admin/models"),
      ]);
      setProviders(o.providers);
      setAliases(o.aliases);
      setModels(m.models);
      setError("");
      setLoaded(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enabledModels = models.filter((m) => m.enabled).length;

  return (
    <AdminPage
      title="模型与提供者"
      subtitle={
        loaded
          ? `${providers.length} 个提供者，${enabledModels} 个启用中的模型。智能体用别名（fable、opus、sonnet、haiku）或模型标识调用`
          : "智能体用别名（fable、opus、sonnet、haiku）或模型标识调用"
      }
      tabs={<AdminTabs label="模型与提供者" items={TABS} value={tab} onChange={setTab} />}
    >
      {/* 读失败时只显示失败 —— 曾经红字下面还挂着"还没有模型提供者",像是真的一个都没有 */}
      {error && !loaded ? (
        <TableCard>
          <LoadError what="模型与提供者" message={error} onRetryAction={() => void load()} />
        </TableCard>
      ) : !loaded ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          正在加载…
        </div>
      ) : (
        <>
          {error && (
            <div className="mb-3">
              <LoadError
                compact
                what="最新数据"
                message={error}
                onRetryAction={() => void load()}
              />
            </div>
          )}
          {tab === "providers" && (
            <ProvidersTab
              providers={providers}
              aliases={aliases}
              loading={loading}
              onReload={() => void load()}
              onCreate={() => setCreating(true)}
            />
          )}
          {tab === "models" && <ModelsTab models={models} />}
          {tab === "routing" && (
            <AliasCard providers={providers} models={models} aliases={aliases} onSaved={load} />
          )}
        </>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </AdminPage>
  );
}

function ProviderIcon() {
  return (
    <span
      aria-hidden
      className="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-band text-[#4D4A43]"
    >
      <Cpu className="size-[18px]" />
    </span>
  );
}

function ProvidersTab({
  providers,
  aliases,
  loading,
  onReload,
  onCreate,
}: {
  providers: ProviderView[];
  aliases: AliasMapView | null;
  loading: boolean;
  onReload: () => void;
  onCreate: () => void;
}) {
  const router = useRouter();
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          点一行进入提供者详情：凭证、按类型的接入地址、模型与价目。
        </p>
        <Button variant="outline" size="sm" disabled={loading} onClick={onReload}>
          <RefreshCw className={cn(loading && "animate-spin")} />
          刷新
        </Button>
        <Button size="sm" onClick={onCreate}>
          <Plus />
          添加提供者
        </Button>
      </div>
      <TableCard>
        {providers.length === 0 ? (
          <EmptyState
            title="还没有模型提供者"
            action={
              <Button size="sm" onClick={onCreate}>
                添加提供者
              </Button>
            }
          >
            添加一个提供者并填入 API Key,智能体才有模型可用。
          </EmptyState>
        ) : (
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <caption className="sr-only">模型提供者</caption>
            <thead>
              <tr>
                {["名称", "API Key", "文本接入", "模型数", "状态"].map((h) => (
                  <th key={h} scope="col" className={TH}>
                    {h}
                  </th>
                ))}
                <th className={TH}>
                  <span className="sr-only">进入</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => {
                const counts = KIND_ORDER.filter((k) => (p.modelCounts?.[k] ?? 0) > 0);
                const total = counts.reduce((s, k) => s + (p.modelCounts?.[k] ?? 0), 0);
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: 整行可点只是鼠标的便利,键盘用行内的按钮或链接
                  <tr
                    key={p.id}
                    className="cursor-pointer hover:bg-[#FAF9F6]"
                    onClick={() => router.push(providerHref(p.id))}
                  >
                    <td className={TD}>
                      <div className="flex items-center gap-2.5">
                        <ProviderIcon />
                        <div className="min-w-0">
                          <Link
                            href={providerHref(p.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="font-semibold underline-offset-4 hover:underline"
                          >
                            {p.name}
                          </Link>
                          {aliases?.providerId === p.id && (
                            <div className="text-xs text-muted-foreground">默认路由使用中</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className={TD}>
                      {p.hasKey ? (
                        <div className="space-y-0.5">
                          <Badge variant="success">已配置</Badge>
                          {p.keyHint && (
                            <div className="font-mono text-xs text-muted-foreground">
                              {p.keyHint}
                            </div>
                          )}
                        </div>
                      ) : (
                        <Badge variant="warning">未配置</Badge>
                      )}
                    </td>
                    <td className={cn(TD, "max-w-80")}>
                      {p.endpoints.llm?.baseUrl ? (
                        <>
                          <div
                            className="truncate font-mono text-[13px]"
                            title={p.endpoints.llm.baseUrl}
                          >
                            {p.endpoints.llm.baseUrl}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {PROTOCOL_LABEL[p.endpoints.llm.protocol] ?? p.endpoints.llm.protocol}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">未填写</span>
                      )}
                    </td>
                    <td className={TD}>
                      <div>{total}</div>
                      {counts.length > 1 && (
                        <div className="text-xs whitespace-nowrap text-muted-foreground">
                          {counts.map((k) => `${KIND_LABEL[k]} ${p.modelCounts?.[k]}`).join("，")}
                        </div>
                      )}
                    </td>
                    <td className={TD}>
                      {p.enabled ? <Badge variant="success">启用</Badge> : <Badge>停用</Badge>}
                    </td>
                    <td className={cn(TD, "text-muted-foreground")}>
                      <ChevronRight className="ml-auto size-4" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </TableCard>
    </>
  );
}

/** 只读：跨提供者对比模型与售价；编辑在所属提供者的详情页。 */
function ModelsTab({ models }: { models: AdminModel[] }) {
  const [kind, setKind] = useState<CapabilityKind>("llm");
  const list = models.filter((m) => m.kind === kind);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Segmented
          label="模型类型"
          value={kind}
          onChange={setKind}
          items={KIND_ORDER.map((k) => ({
            value: k,
            label: `${KIND_LABEL[k]} ${models.filter((m) => m.kind === k).length}`,
          }))}
        />
        <p className="text-sm text-muted-foreground">点模型名到所属提供者页编辑价目。</p>
      </div>
      <TableCard>
        {list.length === 0 ? (
          <EmptyState title={`没有${KIND_LABEL[kind]}模型`}>
            在提供者详情里按类型添加模型。
          </EmptyState>
        ) : (
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <caption className="sr-only">{KIND_LABEL[kind]}模型总览</caption>
            <thead>
              <tr>
                {["模型", "提供者", "售价（积分）", "加价", "状态"].map((h) => (
                  <th key={h} scope="col" className={TH}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id}>
                  <td className={TD}>
                    {m.providerId ? (
                      <Link
                        href={`${providerHref(m.providerId, m.kind)}#model-${m.id}`}
                        className="font-semibold underline-offset-4 hover:underline"
                      >
                        {m.name}
                      </Link>
                    ) : (
                      <span className="font-semibold">{m.name}</span>
                    )}
                    <div className="font-mono text-xs text-muted-foreground">{m.modelId}</div>
                  </td>
                  <td className={TD}>{m.providerName ?? "未归属"}</td>
                  <td className={cn(TD, "text-[13px] leading-6 whitespace-nowrap")}>
                    {priceRows(m).map((r) => (
                      <div key={r.meter}>
                        {r.label}：<span className="font-medium">{r.saleCredits ?? "—"}</span>
                      </div>
                    ))}
                  </td>
                  <td className={TD}>{formatMarkupPercent(m.markupBp ?? 0)}%</td>
                  <td className={TD}>
                    {m.enabled ? <Badge variant="success">启用</Badge> : <Badge>停用</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableCard>
    </>
  );
}

/** 智能体配置里的别名 fable/opus/sonnet/haiku 指向哪个模型；四个必须同一提供者。 */
function AliasCard({
  providers,
  models,
  aliases,
  onSaved,
}: {
  providers: ProviderView[];
  models: AdminModel[];
  aliases: AliasMapView | null;
  onSaved: () => void;
}) {
  const [providerId, setProviderId] = useState("");
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setProviderId(aliases?.providerId ?? providers[0]?.id ?? "");
    setTargets(
      aliases
        ? { fable: aliases.fable, opus: aliases.opus, sonnet: aliases.sonnet, haiku: aliases.haiku }
        : {},
    );
  }, [aliases, providers]);
  const options = models.filter(
    (m) => m.providerId === providerId && m.kind === "llm" && m.enabled,
  );
  const byId = new Map(models.map((m) => [m.id, m]));
  const current = aliases ? providers.find((p) => p.id === aliases.providerId) : undefined;

  if (providers.length === 0) {
    return (
      <TableCard>
        <EmptyState title="还没有提供者">先在「提供者」页签添加提供者和文本模型。</EmptyState>
      </TableCard>
    );
  }

  return (
    <section className="max-w-[860px] rounded-2xl border border-border bg-card px-[22px] py-5">
      <h2 className="text-base font-semibold">默认模型路由</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        智能体里写别名（如 sonnet）时，按这里的映射调用。四个别名必须用同一个提供者的模型。
      </p>
      <label className="mt-4 grid max-w-80 gap-1.5 text-[13px] text-muted-foreground">
        所属提供者
        <NativeSelect
          aria-label="别名所属提供者"
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value);
            setTargets({});
          }}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
      </label>
      <div className="mt-4 border-t border-line-soft">
        {MODEL_ALIASES.map((alias) => {
          const picked = byId.get(targets[alias] ?? "");
          return (
            <div
              key={alias}
              className="grid items-center gap-x-4 gap-y-1.5 border-b border-line-soft py-3 sm:grid-cols-[110px_minmax(0,1fr)_200px]"
            >
              <label htmlFor={`alias-${alias}`} className="font-mono text-sm font-bold">
                {alias}
              </label>
              <NativeSelect
                id={`alias-${alias}`}
                aria-label={`别名 ${alias}`}
                value={targets[alias] ?? ""}
                onChange={(e) => setTargets((t) => ({ ...t, [alias]: e.target.value }))}
              >
                <option value="">选择模型</option>
                {options.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}({m.modelId})
                  </option>
                ))}
              </NativeSelect>
              <div className="text-xs leading-5 text-muted-foreground">
                {picked
                  ? priceRows(picked)
                      .slice(0, 2)
                      .map((r) => (
                        <div key={r.meter}>
                          {r.label}：{r.saleCredits ?? "—"} 积分
                        </div>
                      ))
                  : null}
              </div>
            </div>
          );
        })}
      </div>
      {options.length === 0 && (
        <p className="mt-3 text-sm text-warning-text">
          这个提供者还没有启用的文本模型，先到它的详情页添加。
        </p>
      )}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">
          {aliases ? (
            <>
              <div>当前生效：{current?.name ?? aliases.providerId}</div>
              <div className="mt-1 font-mono break-all text-[#4D4A43]">
                {MODEL_ALIASES.map(
                  (a) => `${a} → ${byId.get(aliases[a])?.modelId ?? aliases[a]}`,
                ).join("  ")}
              </div>
            </>
          ) : (
            "还没有保存过别名映射"
          )}
        </div>
        <Button
          disabled={saving || MODEL_ALIASES.some((a) => !targets[a])}
          onClick={async () => {
            setSaving(true);
            setError("");
            try {
              await fetchJson("/api/admin/model-aliases", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  providerId,
                  ...targets,
                  expectedVersion: aliases?.version ?? null,
                }),
              });
              toast.success("别名映射已保存");
              onSaved();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "保存中…" : "保存别名映射"}
        </Button>
      </div>
    </section>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>添加提供者</DialogTitle>
          <DialogDescription>
            先填名称与凭证；生图、视频等类型的接入地址和模型在详情页按类型配置。
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (saving || !name.trim()) return;
            setSaving(true);
            setError("");
            try {
              const r = await fetchJson<{ provider: ProviderView }>("/api/admin/providers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  definition: {
                    name: name.trim(),
                    enabled: true,
                    endpoints: baseUrl.trim()
                      ? { llm: { protocol: "anthropic", baseUrl: baseUrl.trim() } }
                      : {},
                  },
                  apiKey: apiKey.trim() || undefined,
                }),
              });
              toast.success("提供者已添加");
              router.push(providerHref(r.provider.id));
            } catch (err) {
              setError(errorText(err));
              setSaving(false);
            }
          }}
        >
          <label className="grid gap-1.5 text-[13px] text-muted-foreground">
            <span>
              名称 <span className="text-destructive">*</span>
            </span>
            <Input
              value={name}
              maxLength={120}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-[13px] text-muted-foreground">
            文本接入地址（Anthropic 协议，可稍后填）
            <Input
              value={baseUrl}
              className="font-mono"
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://"
            />
          </label>
          <label className="grid gap-1.5 text-[13px] text-muted-foreground">
            API Key（可稍后填）
            <Input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "添加中…" : "添加"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
