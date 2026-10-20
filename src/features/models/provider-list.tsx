"use client";

import { SpaceShell } from "@/components/space-shell";
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
import { errorText, fetchJson } from "@/lib/fetch-json";
import { MODEL_ALIASES } from "@/lib/shared";
import { Plus, RefreshCw, Save, Server } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  type AdminModel,
  type AliasMapView,
  KIND_LABEL,
  KIND_ORDER,
  type ProviderView,
} from "./model-shared";

export function ProviderList() {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [aliases, setAliases] = useState<AliasMapView | null>(null);
  const [models, setModels] = useState<AdminModel[]>([]);
  const [loading, setLoading] = useState(true);
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
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SpaceShell
      area="admin"
      title="模型提供者"
      subtitle="提供者负责连接(凭证与接入地址),模型在提供者详情页按类型维护"
      actions={
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          添加提供者
        </Button>
      }
    >
      <div className="mb-4 flex justify-end">
        <Button
          size="icon"
          variant="ghost"
          title="刷新"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
      {loading && providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">载入中…</p>
      ) : providers.length === 0 ? (
        <div className="py-14 text-center">
          <Server className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="text-sm">还没有模型提供者</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">模型提供者</caption>
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                {["名称", "API Key", "文本接入", "模型数", "状态"].map((h) => (
                  <th key={h} scope="col" className="px-3 py-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id} className="border-b">
                  <td className="px-3 py-3">
                    <Link
                      href={`/admin/providers/${p.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">
                    {p.hasKey ? p.keyHint : <span className="text-muted-foreground">未配置</span>}
                  </td>
                  <td
                    className="max-w-64 truncate px-3 py-3 font-mono text-xs"
                    title={p.endpoints.llm?.baseUrl}
                  >
                    {p.endpoints.llm?.baseUrl ?? (
                      <span className="text-muted-foreground">未配置</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs whitespace-nowrap">
                    {KIND_ORDER.filter((k) => (p.modelCounts?.[k] ?? 0) > 0)
                      .map((k) => `${KIND_LABEL[k]} ${p.modelCounts?.[k]}`)
                      .join(" · ") || "—"}
                  </td>
                  <td className="px-3 py-3">
                    {p.enabled ? (
                      <Badge variant="secondary">启用</Badge>
                    ) : (
                      <Badge variant="outline">停用</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AliasCard providers={providers} models={models} aliases={aliases} onSaved={load} />

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </SpaceShell>
  );
}

/** 智能体配置里的别名 fable/opus/sonnet/haiku 指向哪个模型;四个必须同一提供者。 */
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

  return (
    <section className="mt-8 rounded-lg border p-4">
      <h2 className="text-sm font-medium">默认模型别名</h2>
      <p className="mt-1 mb-4 text-xs text-muted-foreground">
        智能体配置里写 fable / opus / sonnet / haiku 时使用的模型。四个别名须属于同一提供者。
      </p>
      <div className="grid gap-3 sm:grid-cols-5">
        <label className="grid gap-1.5 text-sm">
          提供者
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
        {MODEL_ALIASES.map((alias) => (
          <label key={alias} className="grid gap-1.5 text-sm">
            {alias}
            <NativeSelect
              aria-label={`别名 ${alias}`}
              value={targets[alias] ?? ""}
              onChange={(e) => setTargets((t) => ({ ...t, [alias]: e.target.value }))}
            >
              <option value="">选择模型</option>
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </NativeSelect>
          </label>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <Button
        size="sm"
        className="mt-4"
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
        <Save className="size-4" />
        保存别名映射
      </Button>
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加提供者</DialogTitle>
          <DialogDescription>
            先填名称与凭证;生图、视频等类型的接入地址和模型在详情页按类型配置。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-sm">
            名称
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm">
            文本接入地址(Anthropic 协议,可稍后填)
            <Input
              value={baseUrl}
              className="font-mono"
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://"
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            API Key(可稍后填)
            <Input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={saving || !name.trim()}
            onClick={async () => {
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
                router.push(`/admin/providers/${r.provider.id}`);
              } catch (err) {
                setError(errorText(err));
                setSaving(false);
              }
            }}
          >
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
