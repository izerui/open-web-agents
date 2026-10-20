"use client";

import { useConfirm } from "@/components/confirm-dialog";
import { SpaceShell } from "@/components/space-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { CapabilityKind } from "@/lib/modules/capabilities/domain/catalog";
import { formatMarkupPercent } from "@/lib/modules/capabilities/domain/pricing";
import { ENDPOINT_PROTOCOLS } from "@/lib/modules/model-gateway/domain/provider";
import { ArrowLeft, KeyRound, Pencil, PlugZap, Plus, Save } from "lucide-react";
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
}

export function ProviderDetail({ id, initialTab }: { id: string; initialTab?: string }) {
  const [provider, setProvider] = useState<ProviderView | null>(null);
  const [models, setModels] = useState<AdminModel[]>([]);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<CapabilityKind>(
    KIND_ORDER.includes(initialTab as CapabilityKind) ? (initialTab as CapabilityKind) : "llm",
  );
  const [editing, setEditing] = useState<{ model: AdminModel | null } | null>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([
        fetchJson<{ provider: ProviderView }>(`/api/admin/providers/${id}`),
        fetchJson<{ models: AdminModel[] }>("/api/admin/models"),
      ]);
      setProvider(p.provider);
      setModels(m.models.filter((x) => x.providerId === id));
      setLoadError("");
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveProvider(next: Partial<Pick<ProviderView, "name" | "enabled" | "endpoints">>) {
    if (!provider) return;
    await fetchJson(`/api/admin/providers/${id}`, {
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

  if (loadError) {
    return (
      <SpaceShell area="admin" title="模型提供者">
        <p className="text-sm text-destructive">{loadError}</p>
      </SpaceShell>
    );
  }
  if (!provider) {
    return (
      <SpaceShell area="admin" title="模型提供者">
        <p className="text-sm text-muted-foreground">载入中…</p>
      </SpaceShell>
    );
  }

  return (
    <SpaceShell
      area="admin"
      title={provider.name}
      subtitle="提供者的凭证与各类型接入地址;模型在下方按类型维护"
      actions={
        <Button asChild variant="ghost">
          <Link href="/admin/providers">
            <ArrowLeft className="size-4" />
            返回列表
          </Link>
        </Button>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <BasicCard
          provider={provider}
          onSave={async (name, enabled) => {
            if (provider.enabled && !enabled) {
              const impact = await fetchJson<Impact>(`/api/admin/providers/${id}/impact`);
              confirm.ask({
                title: `停用「${provider.name}」?`,
                description: `其下所有模型都将不可用,影响 ${impact.agents} 个智能体${impact.aliases.length ? `;别名 ${impact.aliases.join("、")} 指向其下模型` : ""}。进行中的运行不受影响。`,
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

      <Tabs value={tab} onValueChange={(v) => setTab(v as CapabilityKind)} className="mt-6">
        <TabsList>
          {KIND_ORDER.map((k) => (
            <TabsTrigger key={k} value={k}>
              {KIND_LABEL[k]}
              <span className="ml-1 text-xs text-muted-foreground">
                {models.filter((m) => m.kind === k).length}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
        {KIND_ORDER.map((k) => (
          <TabsContent key={k} value={k} className="space-y-6 pt-2">
            <EndpointCard
              provider={provider}
              kind={k}
              models={models.filter((m) => m.kind === k)}
              onSave={(endpoint) =>
                saveProvider({
                  endpoints: { ...provider.endpoints, [k]: endpoint ?? undefined },
                })
              }
            />
            <ModelTable
              kind={k}
              models={models.filter((m) => m.kind === k)}
              onAdd={() => setEditing({ model: null })}
              onEdit={(model) => setEditing({ model })}
            />
          </TabsContent>
        ))}
      </Tabs>

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
    </SpaceShell>
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
  return (
    <section className="rounded-lg border p-4">
      <h2 className="mb-3 text-sm font-medium">基本信息</h2>
      <div className="grid gap-3">
        <label className="grid gap-1.5 text-sm">
          名称
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用
        </label>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div>
          <Button
            size="sm"
            disabled={saving}
            onClick={async () => {
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
            <Save className="size-4" />
            保存
          </Button>
        </div>
      </div>
    </section>
  );
}

function KeyCard({ provider, onReplaced }: { provider: ProviderView; onReplaced: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <section className="rounded-lg border p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <KeyRound className="size-4" />
        API Key
      </h2>
      <p className="mb-3 text-sm">
        {provider.hasKey ? (
          <span className="font-mono">{provider.keyHint}</span>
        ) : (
          <span className="text-muted-foreground">未配置</span>
        )}
      </p>
      <p className="mb-3 text-xs text-muted-foreground">
        加密保存,只能替换,不能查看原文;不会出现在智能体、日志或提示词中。
      </p>
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="new-password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={provider.hasKey ? "输入新 Key 以替换" : "输入 API Key"}
        />
        <Button
          size="sm"
          disabled={saving || !key.trim()}
          onClick={async () => {
            setSaving(true);
            setError("");
            try {
              await fetchJson(`/api/admin/providers/${provider.id}/key`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ apiKey: key.trim() }),
              });
              setKey("");
              toast.success("API Key 已替换");
              onReplaced();
            } catch (err) {
              setError(errorText(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          {provider.hasKey ? "替换" : "保存"}
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </section>
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
    <section className="rounded-lg border p-4">
      <h2 className="mb-3 text-sm font-medium">{KIND_LABEL[kind]}接入地址</h2>
      <div className="grid gap-3 sm:grid-cols-[180px_1fr_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm">
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
        <label className="grid gap-1.5 text-sm">
          Base URL
          <Input
            value={baseUrl}
            className="font-mono"
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://"
          />
        </label>
        <Button
          size="sm"
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
          <Save className="size-4" />
          保存
        </Button>
      </div>

      {kind === "llm" ? (
        <div className="mt-4 flex flex-wrap items-end gap-2 border-t pt-4">
          <label className="grid gap-1.5 text-sm">
            测试用模型
            <Input
              value={testModel}
              list={`models-${provider.id}`}
              className="w-64 font-mono"
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
            size="sm"
            variant="outline"
            disabled={busy || !testModel.trim()}
            onClick={async () => {
              setBusy(true);
              setProbe(null);
              setError("");
              try {
                const r = await fetchJson<{ result: ProbeResult }>(
                  `/api/admin/providers/${provider.id}/test`,
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
            <PlugZap className="size-4" />
            测试连接
          </Button>
          {probe && (
            <p
              aria-live="polite"
              className={`text-sm ${probe.ok ? "text-emerald-600" : "text-destructive"}`}
            >
              {probe.ok
                ? "连接成功"
                : `失败${probe.status ? `(HTTP ${probe.status})` : ""}:${probe.message}`}
              <span className="ml-2 text-xs text-muted-foreground">{probe.latencyMs} ms</span>
            </p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          该类型暂未接入运行时,配置用于价目展示与后续接入,不提供连接测试。
        </p>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </section>
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
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium">{KIND_LABEL[kind]}模型</h2>
        <Button size="sm" onClick={onAdd}>
          <Plus className="size-4" />
          添加模型
        </Button>
      </div>
      {models.length === 0 ? (
        <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
          还没有{KIND_LABEL[kind]}模型
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{KIND_LABEL[kind]}模型与价目</caption>
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                {["名称 / 模型标识", "成本单价(元)", "加价", "售价(积分)", "状态", "版本", ""].map(
                  (h) => (
                    <th key={h} scope="col" className="px-3 py-2">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const rows = priceRows(m);
                const free = m.rates.length > 0 && m.rates.every((r) => r.microCredits === "0");
                return (
                  <tr key={m.id} id={`model-${m.id}`} className="border-b align-top">
                    <td className="px-3 py-3">
                      <p className="font-medium">{m.name}</p>
                      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {m.modelId}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-xs leading-6 whitespace-nowrap">
                      {rows.map((r) => (
                        <p key={r.meter}>
                          {r.label}:{r.costYuan ?? "—"}
                        </p>
                      ))}
                    </td>
                    <td className="px-3 py-3">{formatMarkupPercent(m.markupBp ?? 0)}%</td>
                    <td className="px-3 py-3 font-mono text-xs leading-6 whitespace-nowrap">
                      {rows.map((r) => (
                        <p key={r.meter}>{r.saleCredits ?? "—"}</p>
                      ))}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {m.enabled ? (
                        <Badge variant="secondary">启用</Badge>
                      ) : (
                        <Badge variant="outline">停用</Badge>
                      )}
                      {free && (
                        <Badge variant="outline" className="ml-1">
                          未定价
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-3">v{m.version}</td>
                    <td className="px-3 py-3">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`编辑 ${m.name}`}
                        onClick={() => onEdit(m)}
                      >
                        <Pencil className="size-4" />
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
  );
}
