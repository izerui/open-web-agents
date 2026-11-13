"use client";

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
import { Switch } from "@/components/ui/switch";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { DEFAULT_RESERVE_MICRO } from "@/lib/modules/billing/domain/run-charge";
import {
  type CapabilityKind,
  formatCredits,
  parseCredits,
} from "@/lib/modules/capabilities/domain/catalog";
import {
  STANDARD_METERS,
  deriveSaleRates,
  formatMarkupPercent,
  parseMarkupPercent,
  parseYuan,
} from "@/lib/modules/capabilities/domain/pricing";
import { AlertTriangle, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  type AdminModel,
  type Impact,
  KIND_LABEL,
  creditsText,
  markupHint,
  perStandard,
  yuanText,
} from "./model-shared";

interface Props {
  providerId: string;
  kind: CapabilityKind;
  /** 编辑已有模型;不给 = 新建 */
  model: AdminModel | null;
  onClose: () => void;
  onSaved: () => void;
}

const parseOr = <T,>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

export function ModelDialog({ providerId, kind, model, onClose, onSaved }: Props) {
  const meters = STANDARD_METERS[kind];
  const [name, setName] = useState(model?.name ?? "");
  const [modelId, setModelId] = useState(model?.modelId ?? "");
  const [enabled, setEnabled] = useState(model?.enabled ?? true);
  const [acceptsImages, setAcceptsImages] = useState(model?.acceptsImages ?? false);
  const [markup, setMarkup] = useState(formatMarkupPercent(model?.markupBp ?? 1000));
  // 单次运行冻结额(积分);空 = 平台默认
  const [reserve, setReserve] = useState(
    model?.reserveMicroCredits ? formatCredits(model.reserveMicroCredits) : "",
  );
  const [costs, setCosts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      meters.map((m) => {
        const c = perStandard(model?.costRates, m.meter, m.units);
        return [m.meter, c ? yuanText(c.micro) : ""];
      }),
    ),
  );
  const legacyUnits = useMemo(
    () => meters.some((m) => perStandard(model?.costRates, m.meter, m.units)?.exact === false),
    [meters, model],
  );
  const [impact, setImpact] = useState<Impact | null>(null);
  const [error, setError] = useState("");
  /** 没过校验的那一栏:红框,红字写在它下面 */
  const [errField, setErrField] = useState<string | null>(null);
  const fail = (field: string, text: string) => {
    setErrField(field);
    setError(text);
  };
  const fieldError = (field: string) =>
    errField === field && error ? <span className="text-xs text-destructive">{error}</span> : null;
  const [saving, setSaving] = useState(false);

  // 停用已启用的模型前先看影响面
  const disabling = !!model?.enabled && !enabled;
  useEffect(() => {
    if (!disabling || !model) return;
    let alive = true;
    fetchJson<Impact>(`/api/admin/models/${model.id}/impact`)
      .then((r) => alive && setImpact(r))
      .catch(() => alive && setImpact(null));
    return () => {
      alive = false;
    };
  }, [disabling, model]);

  const markupBp = parseOr(() => parseMarkupPercent(markup.trim()));
  const hint = markupHint(markup);
  const preview = meters.map((m) => {
    const cost = parseOr(() => parseYuan((costs[m.meter] ?? "").trim()));
    const sale =
      cost !== null && markupBp !== null
        ? deriveSaleRates([{ meter: m.meter, units: m.units, microCredits: cost }], markupBp)[0]
            ?.microCredits
        : null;
    return { ...m, cost, sale };
  });

  async function save() {
    setError("");
    setErrField(null);
    if (!name.trim()) return fail("name", "请填写显示名称");
    if (!modelId.trim()) return fail("modelId", "请填写模型标识");
    if (markupBp === null) return fail("markup", "加价比例须为非负数，最多 2 位小数，不超过 1000%");
    const reserveMicro = reserve.trim() ? parseOr(() => parseCredits(reserve.trim())) : null;
    if (kind === "llm" && reserve.trim() && (reserveMicro === null || reserveMicro === "0")) {
      return fail("reserve", "单次运行冻结须为大于零的积分数（最多六位小数），留空用平台默认");
    }
    const missing = preview.find((p) => p.cost === null);
    if (missing)
      return fail(missing.meter, `请填写「${missing.label}」的成本单价（元，最多 8 位小数）`);
    setSaving(true);
    try {
      await fetchJson("/api/admin/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: model?.version ?? null,
          definition: {
            ...(model ? { id: model.id } : {}),
            name: name.trim(),
            kind,
            modelId: modelId.trim(),
            enabled,
            acceptsImages: kind === "llm" && acceptsImages,
            providerId,
            markupBp,
            ...(kind === "llm" && reserveMicro ? { reserveMicroCredits: reserveMicro } : {}),
            costRates: preview.map((p) => ({
              meter: p.meter,
              units: p.units,
              microCredits: p.cost,
            })),
            rates: [],
          },
        }),
      });
      toast.success(model ? "模型已保存为新版本" : "模型已添加");
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {model ? `编辑模型「${model.name}」` : `添加${KIND_LABEL[kind]}模型`}
          </DialogTitle>
          <DialogDescription>
            按成本单价（人民币）录入，系统按 1 元 = 100
            积分换算，再乘以加价得到用户看到的售价。每次保存生成新版本，进行中的运行按原版本结算。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm">
            显示名称
            <Input
              value={name}
              maxLength={120}
              aria-invalid={errField === "name" || undefined}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 Claude Sonnet 4.5"
            />
            {fieldError("name")}
          </label>
          <label className="grid gap-1.5 text-sm">
            模型标识
            <Input
              value={modelId}
              maxLength={200}
              className="font-mono"
              aria-invalid={errField === "modelId" || undefined}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="发给提供者的真实模型 id"
            />
            {fieldError("modelId")}
          </label>
          <label className="grid gap-1.5 text-sm">
            加价比例（%，不超过 1000%）
            <Input
              value={markup}
              inputMode="decimal"
              aria-invalid={hint?.tone === "bad" || undefined}
              aria-describedby="model-markup-hint"
              onChange={(e) => setMarkup(e.target.value)}
            />
            {hint?.tone === "bad" && (
              <span id="model-markup-hint" aria-live="polite" className="text-xs text-destructive">
                {hint.text}
              </span>
            )}
          </label>
          {kind === "llm" && (
            <label className="grid gap-1.5 text-sm">
              单次运行冻结（积分）
              <Input
                value={reserve}
                inputMode="decimal"
                placeholder={`留空用平台默认 ${formatCredits(DEFAULT_RESERVE_MICRO.toString())}`}
                aria-invalid={errField === "reserve" || undefined}
                onChange={(e) => setReserve(e.target.value)}
              />
              {fieldError("reserve")}
              <span className="text-xs text-muted-foreground">
                每次运行发起先冻结这么多，用到八成自动追加；结束按实际用量扣除。
              </span>
            </label>
          )}
          <div className="flex flex-col justify-end gap-2 pb-1 text-sm">
            <label htmlFor="model-enabled" className="flex min-h-10 items-center gap-2.5">
              <Switch
                id="model-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
                className="data-[state=checked]:bg-success"
              />
              启用
            </label>
            {kind === "llm" && (
              <label htmlFor="model-images" className="flex min-h-10 items-center gap-2.5">
                <Switch
                  id="model-images"
                  checked={acceptsImages}
                  onCheckedChange={setAcceptsImages}
                  className="data-[state=checked]:bg-success"
                />
                支持图片输入
              </label>
            )}
          </div>
        </div>

        {hint?.tone === "warn" && (
          <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            {hint.text}
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">成本单价与积分换算</caption>
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3">
                  计量
                </th>
                <th scope="col" className="py-2 pr-3">
                  成本单价（元）
                </th>
                <th scope="col" className="py-2 pr-3">
                  成本积分价
                </th>
                <th scope="col" className="py-2">
                  售价积分价（用户可见）
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.map((p) => (
                <tr key={p.meter} className="border-b">
                  <td className="py-2 pr-3 whitespace-nowrap">{p.label}</td>
                  <td className="py-2 pr-3">
                    <Input
                      aria-label={`${p.label} 成本单价`}
                      value={costs[p.meter] ?? ""}
                      inputMode="decimal"
                      className="h-8 w-36 font-mono"
                      aria-invalid={errField === p.meter || undefined}
                      onChange={(e) => setCosts((c) => ({ ...c, [p.meter]: e.target.value }))}
                      placeholder="0"
                    />
                  </td>
                  <td className="py-2 pr-3 font-mono">
                    {p.cost !== null ? creditsText(p.cost) : "—"}
                  </td>
                  <td className="py-2 font-mono">{p.sale ? creditsText(p.sale) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {legacyUnits && (
          <p className="text-xs text-muted-foreground">
            这个模型的旧价目使用非标准单位，已按标准单位向上取整显示；保存后统一为标准单位。
          </p>
        )}

        {disabling && (
          <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            {impact
              ? `停用后影响 ${impact.agents} 个智能体${impact.aliases.length ? `；别名 ${impact.aliases.join("、")} 指向此模型，使用这些别名的智能体也会无法运行` : ""}。进行中的运行不受影响。`
              : "正在统计影响的智能体…"}
          </p>
        )}

        {error && !["name", "modelId", "markup", "reserve"].includes(errField ?? "") && (
          <p aria-live="assertive" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            <Save className="size-4" />
            {saving ? "保存中…" : model ? `保存为 v${model.version + 1}` : "保存为 v1"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
