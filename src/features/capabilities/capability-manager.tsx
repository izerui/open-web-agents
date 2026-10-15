"use client";

import { SpaceShell } from "@/components/space-shell";
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
import {
  CAPABILITY_KINDS,
  type Capability,
  type CapabilityKind,
  KIND_METERS,
  type Meter,
  formatCredits,
  parseCredits,
} from "@/lib/modules/capabilities/domain/catalog";
import { Check, Cpu, Pencil, Plus, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

const KIND_LABEL: Record<CapabilityKind, string> = {
  llm: "文本与图片理解",
  image: "图片生成",
  video: "视频生成",
  speech: "语音生成",
  transcription: "语音理解",
};
const METER_LABEL: Record<Meter, string> = {
  input_token: "输入 token",
  output_token: "输出 token",
  cache_read_token: "缓存读取 token",
  cache_write_token: "缓存写入 token",
  image: "张图片",
  video_ms: "毫秒视频",
  audio_input_ms: "毫秒输入音频",
  audio_output_ms: "毫秒输出音频",
  character: "字符",
};

interface Draft {
  id: string;
  name: string;
  kind: CapabilityKind;
  modelId: string;
  enabled: boolean;
  acceptsImages: boolean;
  version: number | null;
  rates: Partial<Record<Meter, { units: string; credits: string }>>;
}

type Item = Capability & { available: boolean };
const empty = (): Draft => ({
  id: "",
  name: "",
  kind: "llm",
  modelId: "",
  enabled: false,
  acceptsImages: false,
  version: null,
  rates: {},
});

export function CapabilityManager() {
  const [items, setItems] = useState<Item[]>([]);
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchJson<{
        capabilities: Item[];
        modelSlots: Record<string, string>;
      }>("/api/capabilities?manage=1");
      setItems(result.capabilities);
      setSlots(result.modelSlots);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function edit(item: Item) {
    setDraft({
      id: item.id,
      name: item.name,
      kind: item.kind,
      modelId: item.modelId,
      enabled: item.enabled,
      acceptsImages: item.acceptsImages,
      version: item.version,
      rates: Object.fromEntries(
        item.rates.map((r) => [
          r.meter,
          {
            units: r.units,
            credits: formatCredits(r.microCredits),
          },
        ]),
      ),
    });
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const rates = KIND_METERS[draft.kind].flatMap((meter) => {
        const value = draft.rates[meter];
        return value
          ? [{ meter, units: value.units, microCredits: parseCredits(value.credits) }]
          : [];
      });
      await fetchJson("/api/capabilities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: draft.version,
          definition: {
            id: draft.id,
            name: draft.name,
            kind: draft.kind,
            modelId: draft.modelId,
            enabled: draft.enabled,
            acceptsImages: draft.acceptsImages,
            rates,
          },
        }),
      });
      setDraft(null);
      toast.success("模型与价目版本已保存");
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SpaceShell
      area="admin"
      title="模型与价目"
      subtitle="平台模型能力、积分价目与版本"
      actions={
        <Button
          onClick={() => {
            setError("");
            setDraft(empty());
          }}
        >
          <Plus className="size-4" />
          添加模型
        </Button>
      }
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <p className="text-sm text-muted-foreground">
          价目配置阶段，尚未启用积分扣款。媒体供应商未接入时显示“待接入”。
        </p>
        <Button
          size="icon"
          variant="ghost"
          title="刷新目录"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {error && !draft && (
        <p aria-live="assertive" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {loading ? (
        <p className="text-sm text-muted-foreground">载入中…</p>
      ) : items.length === 0 ? (
        <div className="py-14 text-center">
          <Cpu className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="text-sm">尚未配置模型价目</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">平台模型能力目录</caption>
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                {["名称 / 模型", "能力", "版本", "状态", "积分价目", "操作"].map((name) => (
                  <th key={name} scope="col" className="px-3 py-3">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b align-top">
                  <td className="px-3 py-4">
                    <p className="font-medium">{item.name}</p>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {item.modelId}
                    </p>
                  </td>
                  <td className="whitespace-nowrap px-3 py-4">
                    {KIND_LABEL[item.kind]}
                    {item.acceptsImages && (
                      <p className="mt-1 text-xs text-muted-foreground">含图片理解</p>
                    )}
                  </td>
                  <td className="px-3 py-4">v{item.version}</td>
                  <td className="whitespace-nowrap px-3 py-4">
                    {!item.enabled ? "已停用" : item.available ? "已配置" : "待接入"}
                  </td>
                  <td className="px-3 py-4">
                    {item.rates.length
                      ? item.rates.map((r) => (
                          <p key={r.meter} className="whitespace-nowrap text-xs leading-6">
                            {formatCredits(r.microCredits)} 积分 / {r.units} {METER_LABEL[r.meter]}
                          </p>
                        ))
                      : "未定价"}
                  </td>
                  <td className="px-3 py-4">
                    <Button
                      variant="ghost"
                      size="icon"
                      title={`编辑${item.name}`}
                      onClick={() => edit(item)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setDraft(null);
        }}
      >
        <DialogContent className="flex h-[min(90dvh,48rem)] max-h-[90dvh] flex-col overflow-hidden sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{draft?.version ? `编辑 ${draft.name}` : "添加模型能力"}</DialogTitle>
            <DialogDescription>
              每次保存生成新版本，已有价目版本保留。启用目录项不会自动接通供应商。
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
              className="flex min-h-0 flex-1 flex-col gap-4"
            >
              {error && (
                <p aria-live="assertive" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
                <fieldset disabled={saving} className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-sm" htmlFor="cap-id">
                      <span>标识</span>
                      <Input
                        id="cap-id"
                        required
                        disabled={draft.version !== null}
                        value={draft.id}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            id: e.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="space-y-1 text-sm" htmlFor="cap-name">
                      <span>名称</span>
                      <Input
                        id="cap-name"
                        required
                        value={draft.name}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            name: e.target.value,
                          })
                        }
                      />
                    </label>
                  </div>
                  <label className="block space-y-1 text-sm" htmlFor="cap-kind">
                    <span>能力类型</span>
                    <NativeSelect
                      id="cap-kind"
                      value={draft.kind}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          kind: e.target.value as CapabilityKind,
                          acceptsImages: false,
                          rates: {},
                        })
                      }
                    >
                      {CAPABILITY_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {KIND_LABEL[kind]}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <label className="block space-y-1 text-sm" htmlFor="cap-model">
                    <span>实际模型标识</span>
                    <Input
                      id="cap-model"
                      list="platform-models"
                      required
                      value={draft.modelId}
                      onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
                    />
                    <datalist id="platform-models">
                      {[...new Set(Object.values(slots))].map((model) => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  </label>
                  <div className="flex flex-wrap gap-4 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            enabled: e.target.checked,
                          })
                        }
                      />
                      启用目录项
                    </label>
                    {draft.kind === "llm" && (
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={draft.acceptsImages}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              acceptsImages: e.target.checked,
                            })
                          }
                        />
                        支持图片理解
                      </label>
                    )}
                  </div>
                  <fieldset className="space-y-3 border-t pt-3">
                    <legend className="px-1 text-sm font-medium">积分计价</legend>
                    {KIND_METERS[draft.kind].map((meter) => {
                      const rate = draft.rates[meter];
                      return (
                        <div key={meter} className="space-y-2">
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={!!rate}
                              onChange={(e) => {
                                const rates = { ...draft.rates };
                                if (e.target.checked)
                                  rates[meter] = {
                                    units: meter.endsWith("token")
                                      ? "1000000"
                                      : meter.endsWith("_ms")
                                        ? "1000"
                                        : "1",
                                    credits: "",
                                  };
                                else delete rates[meter];
                                setDraft({
                                  ...draft,
                                  rates,
                                });
                              }}
                            />
                            {METER_LABEL[meter]}
                          </label>
                          {rate && (
                            <div className="grid grid-cols-2 gap-3 pl-5">
                              <label className="text-xs" htmlFor={`units-${meter}`}>
                                每多少单位
                                <Input
                                  id={`units-${meter}`}
                                  inputMode="numeric"
                                  required
                                  value={rate.units}
                                  onChange={(e) =>
                                    setDraft({
                                      ...draft,
                                      rates: {
                                        ...draft.rates,
                                        [meter]: { ...rate, units: e.target.value },
                                      },
                                    })
                                  }
                                />
                              </label>
                              <label className="text-xs" htmlFor={`price-${meter}`}>
                                积分
                                <Input
                                  id={`price-${meter}`}
                                  inputMode="decimal"
                                  required
                                  value={rate.credits}
                                  onChange={(e) =>
                                    setDraft({
                                      ...draft,
                                      rates: {
                                        ...draft.rates,
                                        [meter]: { ...rate, credits: e.target.value },
                                      },
                                    })
                                  }
                                />
                              </label>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </fieldset>
                </fieldset>
              </div>
              <DialogFooter className="shrink-0 border-t bg-background pt-3">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => setDraft(null)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? <Check className="size-4" /> : <Save className="size-4" />}保存版本
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </SpaceShell>
  );
}
