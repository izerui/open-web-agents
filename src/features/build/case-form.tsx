"use client";

// 评测用例表单(全部字段):用例名*、输入*(可按 JSON 对象解析)、期望成功、须包含/不得包含、
// 结构化字段等于、花费上限、耗时上限。评测阶段编辑与试聊「存为评测用例」(A6)共用。

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type EvalCaseForm, buildCaseBody } from "@/features/builder/eval-form";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Field, inputMono } from "./ui";

export function CaseForm({
  initial,
  agentId,
  caseId,
  hasInputSchema,
  title,
  note,
  footnote,
  source,
  onSaved,
  onCancel,
  className,
}: {
  initial: EvalCaseForm;
  agentId: string;
  /** 编辑已有用例;不给 = 新增 */
  caseId?: string;
  hasInputSchema: boolean;
  title: ReactNode;
  note?: ReactNode;
  footnote?: ReactNode;
  /** 新建用例的来源(试聊里存的传 trial);只在新建时发给服务端 */
  source?: "manual" | "trial";
  /** 新建时带上新用例的 id */
  onSaved: (id?: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [f, setF] = useState(initial);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const patch = (p: Partial<EvalCaseForm>) => {
    setF((x) => ({ ...x, ...p }));
    setError("");
  };

  async function save() {
    const built = buildCaseBody(f);
    if (!built.ok) return setError(built.error);
    setSaving(true);
    try {
      const base = `/api/agents/${encodeURIComponent(agentId)}/evals/cases`;
      const r = await fetchJson<{ case?: { id?: string } }>(caseId ? `${base}/${caseId}` : base, {
        method: caseId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(caseId || !source ? built.body : { ...built.body, source }),
      });
      onSaved(r?.case?.id);
    } catch (e) {
      setError(`保存用例失败：${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cn("rounded-[14px] border border-border bg-[#FBFAF7] p-3.5", className)}>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <b>{title}</b>
        {note && <span className="text-[13px] text-muted-foreground">{note}</span>}
      </div>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="用例名" required>
          <Input
            aria-label="用例名"
            value={f.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="例如 超额需审批"
          />
        </Field>
        <Field label="结构化字段等于（每行「路径 = 值」）">
          <Textarea
            aria-label="结构化字段等于"
            className={cn("min-h-[38px] resize-y", inputMono)}
            rows={2}
            value={f.fieldEquals}
            onChange={(e) => patch({ fieldEquals: e.target.value })}
            placeholder={'verdict = "reject"'}
          />
        </Field>
      </div>
      <Field label="输入" required>
        <Textarea
          aria-label="用例输入"
          className={cn("min-h-16 resize-y", inputMono)}
          value={f.input}
          onChange={(e) => patch({ input: e.target.value })}
          placeholder={f.inputIsJson ? '{"invoice_url": "…", "amount": 6800}' : "输入文本"}
        />
      </Field>
      <div className="mb-3 flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            className="size-4 accent-[#1C1C1C]"
            checked={f.inputIsJson}
            onChange={(e) => patch({ inputIsJson: e.target.checked })}
          />
          输入按 JSON 对象解析{hasInputSchema ? "（有 inputSchema，默认勾选）" : ""}
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            className="size-4 accent-[#1C1C1C]"
            checked={f.expectSuccess}
            onChange={(e) => patch({ expectSuccess: e.target.checked })}
          />
          期望运行成功（取消表示期望失败）
        </label>
      </div>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="正文须包含（每行一个）">
          <Textarea
            aria-label="正文须包含"
            className="min-h-[38px] resize-y"
            rows={2}
            value={f.contains}
            onChange={(e) => patch({ contains: e.target.value })}
          />
        </Field>
        <Field label="正文不得包含（每行一个）">
          <Textarea
            aria-label="正文不得包含"
            className="min-h-[38px] resize-y"
            rows={2}
            value={f.notContains}
            onChange={(e) => patch({ notContains: e.target.value })}
          />
        </Field>
        <Field label="花费上限（美元，正数，可选）">
          <Input
            aria-label="花费上限"
            inputMode="decimal"
            value={f.maxCostUsd}
            onChange={(e) => patch({ maxCostUsd: e.target.value })}
          />
        </Field>
        <Field label="耗时上限（秒，正数，可选）">
          <Input
            aria-label="耗时上限"
            inputMode="decimal"
            value={f.maxDurationSec}
            onChange={(e) => patch({ maxDurationSec: e.target.value })}
          />
        </Field>
      </div>
      {error && (
        <p className="mt-0 mb-2 text-[13px] text-destructive" aria-live="polite">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving && <Loader2 className="animate-spin" />}
          保存用例
        </Button>
        <Button size="sm" variant="outline" disabled={saving} onClick={onCancel}>
          取消
        </Button>
        {footnote && <span className="text-[13px] text-muted-foreground">{footnote}</span>}
      </div>
    </div>
  );
}
