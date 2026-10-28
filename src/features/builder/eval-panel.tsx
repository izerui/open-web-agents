"use client";

import { FlaskConical, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect as Select } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { errorText, fetchJson } from "@/lib/fetch-json";
import {
  EMPTY_FORM,
  type EvalAssertionsBody,
  type EvalCaseForm,
  buildCaseBody,
  formFromCase,
  summarizeAssertions,
} from "./eval-form";

interface EvalCase {
  id: string;
  name: string;
  input: unknown;
  assertions: EvalAssertionsBody;
}

interface EvalRun {
  id: string;
  agentVersion?: number;
  /** 这次评测固定下来的配置的摘要:草稿没有版本号,靠它认出两次跑的是不是同一份配置 */
  configHash?: string;
  status: "running" | "done";
  total: number;
  passed: number;
  failed: number;
  createdAt: number;
  /** 与当前(已保存的)草稿内容相同 */
  matchesDraft?: boolean;
  /** 与哪些版本内容相同 */
  matchesVersions?: number[];
  /** 评测之后用例有改动(或评测早于用例核对,无法确认) */
  casesChanged?: boolean;
}

/** 与服务端 EvalOutput 同形(见 eval/domain/assertions.ts) */
interface EvalOutput {
  status: string;
  text?: string;
  textTruncated?: boolean;
  structured?: unknown;
  structuredPreview?: string;
  error?: string;
}

interface EvalResult {
  caseId: string;
  caseName: string;
  status: "pending" | "passed" | "failed" | "error";
  failures?: string[];
  output?: EvalOutput;
  taskId?: string;
  costMicroUsd?: number;
  durationMs?: number;
}

const STATUS: Record<
  EvalResult["status"],
  { text: string; variant: "success" | "destructive" | "warning" | "secondary" }
> = {
  passed: { text: "通过", variant: "success" },
  failed: { text: "未通过", variant: "destructive" },
  error: { text: "未能运行", variant: "warning" },
  pending: { text: "运行中", variant: "secondary" },
};

/**
 * 评测:给智能体配一组标准输入与规则断言,对草稿或某个已发布版本跑一遍,看通过率。
 * 只在点了"运行评测"才跑 —— 每个用例真正调用一次模型,花费记在你名下。
 */
export function EvalPanel({
  agentId,
  publishedVersion,
  hasInputSchema,
  unsaved,
  draft,
  onChanged,
}: {
  agentId: string;
  publishedVersion: number | null;
  /** 智能体声明了 inputSchema:新用例默认按 JSON 输入 */
  hasInputSchema: boolean;
  /** 表单有未保存的修改:评测跑的是已保存的草稿 */
  unsaved: boolean;
  /** 已保存的草稿(重新读取后是新对象):变了就重读,重新标出各次评测对应哪份内容 */
  draft: unknown;
  /** 用例或评测有变化(发布面板据此重读评测结论) */
  onChanged: () => void;
}) {
  const base = `/api/agents/${encodeURIComponent(agentId)}/evals`;
  const [cases, setCases] = useState<EvalCase[] | null>(null);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  /** 正在编辑的用例:null = 没在编辑;id 为空 = 新增 */
  const [editing, setEditing] = useState<{ id: string | null; form: EvalCaseForm } | null>(null);
  const [target, setTarget] = useState<string>("draft");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{ run: EvalRun; results: EvalResult[] } | null>(null);

  // 通知不作为重读的依据:父组件每次渲染给的都是新函数
  const notify = useRef(onChanged);
  notify.current = onChanged;
  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([
        fetchJson<{ cases: EvalCase[] }>(`${base}/cases`),
        fetchJson<{ runs: EvalRun[] }>(`${base}/runs`),
      ]);
      setCases(c.cases);
      setRuns(r.runs);
      notify.current();
    } catch (e) {
      setCases([]);
      toast.error(`评测加载失败:${errorText(e)}`);
    }
  }, [base]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: draft 只是重读的信号
  useEffect(() => {
    void load();
  }, [load, draft]);

  const openRun = useCallback(
    async (id: string) => {
      try {
        setDetail(await fetchJson<{ run: EvalRun; results: EvalResult[] }>(`${base}/runs/${id}`));
      } catch (e) {
        toast.error(`读取评测失败:${errorText(e)}`);
      }
    },
    [base],
  );

  // 正在跑的评测每 2 秒刷新一次(读的时候服务端顺带判分);跑完刷新历史
  useEffect(() => {
    if (!detail || detail.run.status !== "running") return;
    const t = setTimeout(async () => {
      await openRun(detail.run.id);
    }, 2000);
    return () => clearTimeout(t);
  }, [detail, openRun]);
  useEffect(() => {
    if (detail?.run.status === "done") void load();
  }, [detail?.run.status, load]);

  async function saveCase() {
    if (!editing) return;
    const built = buildCaseBody(editing.form);
    if (!built.ok) {
      toast.error(built.error);
      return;
    }
    try {
      await fetchJson(editing.id ? `${base}/cases/${editing.id}` : `${base}/cases`, {
        method: editing.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.body),
      });
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(`保存用例失败:${errorText(e)}`);
    }
  }

  async function deleteCase(c: EvalCase) {
    if (!window.confirm(`删除用例「${c.name}」？历史评测里的记录保留。`)) return;
    try {
      await fetchJson(`${base}/cases/${c.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      toast.error(`删除失败:${errorText(e)}`);
    }
  }

  async function run() {
    if (!cases?.length || busy) return;
    const label = target === "draft" ? "草稿" : `v${target}`;
    if (
      !window.confirm(
        `对${label}跑 ${cases.length} 个用例:每个用例会真正调用一次模型,花费记在你名下。继续？`,
      )
    )
      return;
    setBusy(true);
    try {
      const r = await fetchJson<{ run: EvalRun }>(`${base}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: target === "draft" ? "draft" : Number(target) }),
      });
      await load();
      await openRun(r.run.id);
    } catch (e) {
      toast.error(`发起评测失败:${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const f = editing?.form;
  const setF = (patch: Partial<EvalCaseForm>) =>
    setEditing((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <FlaskConical className="size-4" /> 评测
        </CardTitle>
        <CardDescription>
          配一组标准输入与规则断言,发布前跑一遍看通过率。只在点了「运行评测」才跑,每个用例调用一次模型。
          发布要求:对当前草稿的评测全部通过,且之后没有改过配置或用例。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="divide-y divide-border rounded border">
          {cases === null && <p className="p-2 text-xs text-muted-foreground">载入中…</p>}
          {cases?.length === 0 && <p className="p-2 text-xs text-muted-foreground">还没有用例</p>}
          {cases?.map((c) => (
            <div key={c.id} className="flex items-center gap-2 p-2 text-xs">
              <span className="w-32 shrink-0 truncate font-medium">{c.name}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {summarizeAssertions(c.assertions)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`编辑用例 ${c.name}`}
                onClick={() => setEditing({ id: c.id, form: formFromCase(c) })}
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-destructive"
                aria-label={`删除用例 ${c.name}`}
                onClick={() => void deleteCase(c)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>

        {f ? (
          <div className="space-y-2 rounded border p-2">
            <Input
              value={f.name}
              onChange={(e) => setF({ name: e.target.value })}
              placeholder="用例名,如「正常合同」"
            />
            <Textarea
              className="min-h-[4rem] font-mono text-xs"
              value={f.input}
              onChange={(e) => setF({ input: e.target.value })}
              placeholder={f.inputIsJson ? '输入(JSON 对象),如 {"contract": "……"}' : "输入文本"}
            />
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={f.inputIsJson}
                onChange={(e) => setF({ inputIsJson: e.target.checked })}
              />
              按 JSON 对象输入(智能体声明了 inputSchema 时用)
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={f.expectSuccess}
                onChange={(e) => setF({ expectSuccess: e.target.checked })}
              />
              期望运行成功(取消勾选 = 期望它失败,如应当拒绝的输入)
            </label>
            <div className="grid grid-cols-2 gap-2">
              <Textarea
                className="min-h-[3rem] text-xs"
                value={f.contains}
                onChange={(e) => setF({ contains: e.target.value })}
                placeholder="正文须包含(每行一个)"
              />
              <Textarea
                className="min-h-[3rem] text-xs"
                value={f.notContains}
                onChange={(e) => setF({ notContains: e.target.value })}
                placeholder="正文不得包含(每行一个)"
              />
            </div>
            <Textarea
              className="min-h-[3rem] font-mono text-xs"
              value={f.fieldEquals}
              onChange={(e) => setF({ fieldEquals: e.target.value })}
              placeholder={
                '结构化结果字段等于(每行「路径 = 值」),如\nverdict = "pass"\nissues[0].level = "high"'
              }
            />
            <div className="flex gap-2">
              <Input
                value={f.maxCostUsd}
                onChange={(e) => setF({ maxCostUsd: e.target.value })}
                placeholder="花费上限(美元,可空)"
              />
              <Input
                value={f.maxDurationSec}
                onChange={(e) => setF({ maxDurationSec: e.target.value })}
                placeholder="耗时上限(秒,可空)"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void saveCase()}>
                保存用例
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setEditing({ id: null, form: { ...EMPTY_FORM, inputIsJson: hasInputSchema } })
            }
          >
            <Plus className="size-3.5" /> 新增用例
          </Button>
        )}

        <div className="flex items-center gap-2">
          <Select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-40"
            aria-label="评测哪个版本"
          >
            <option value="draft">草稿(已保存的)</option>
            {publishedVersion !== null &&
              Array.from({ length: publishedVersion }, (_, i) => publishedVersion - i).map((v) => (
                <option key={v} value={String(v)}>
                  v{v}
                  {v === publishedVersion ? "(当前发布)" : ""}
                </option>
              ))}
          </Select>
          <Button size="sm" disabled={busy || !cases?.length} onClick={() => void run()}>
            <Play className="size-3.5" /> 运行评测
          </Button>
        </div>
        {unsaved && target === "draft" && (
          <p className="text-xs text-warning">
            表单有未保存的修改:评测跑的是已保存的草稿,先保存再评测。
          </p>
        )}

        {runs.length > 0 && (
          <div className="divide-y divide-border rounded border">
            {runs.map((r) => (
              <button
                type="button"
                key={r.id}
                className="flex w-full items-center gap-2 p-2 text-left text-xs hover:bg-accent"
                onClick={() => void openRun(r.id)}
              >
                <span className="w-28 shrink-0 font-mono" title={r.configHash}>
                  {r.agentVersion !== undefined ? `v${r.agentVersion}` : "草稿"}
                  {r.configHash && (
                    <span className="ml-1 text-muted-foreground">#{r.configHash.slice(0, 7)}</span>
                  )}
                </span>
                <span className="shrink-0" data-testid="eval-run-match">
                  {r.matchesDraft && <Badge variant="success">= 当前草稿</Badge>}
                  {r.matchesVersions?.map((v) => (
                    <Badge key={v} variant="secondary" className="ml-1">
                      = v{v}
                    </Badge>
                  ))}
                  {!r.matchesDraft && !r.matchesVersions?.length && (
                    <Badge variant="warning">配置已变化</Badge>
                  )}
                  {r.casesChanged && (
                    <Badge variant="warning" className="ml-1">
                      用例已改动
                    </Badge>
                  )}
                </span>
                <span className="flex-1">
                  {r.status === "running"
                    ? "运行中…"
                    : `通过 ${r.passed} / ${r.total}(${Math.round((r.passed / Math.max(1, r.total)) * 100)}%)`}
                </span>
                <span className="text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        )}

        {detail && (
          <div className="space-y-1.5 rounded border bg-muted/30 p-2 text-xs">
            <p className="font-medium">
              {detail.run.agentVersion !== undefined ? `v${detail.run.agentVersion}` : "草稿"} ·{" "}
              {detail.run.status === "running"
                ? "运行中(自动刷新)"
                : `通过 ${detail.run.passed} / ${detail.run.total}`}
            </p>
            {detail.results.map((r) => (
              <div key={r.caseId} className="space-y-0.5">
                <p className="flex items-center gap-2">
                  <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].text}</Badge>
                  <span className="font-medium">{r.caseName}</span>
                  {r.costMicroUsd !== undefined && (
                    <span className="text-muted-foreground">
                      ${(r.costMicroUsd / 1e6).toFixed(4)}
                    </span>
                  )}
                  {r.durationMs !== undefined && (
                    <span className="text-muted-foreground">
                      {(r.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                  {r.taskId && (
                    <span className="font-mono text-muted-foreground">运行 {r.taskId}</span>
                  )}
                </p>
                {r.failures?.map((x) => (
                  <p key={x} className="pl-2 text-destructive">
                    · {x}
                  </p>
                ))}
                {r.output && <OutputSnapshot output={r.output} open={r.status !== "passed"} />}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 判分时看到的输出:没通过的默认展开 —— 看清模型回了什么,才分得清是智能体的问题还是断言写错了 */
function OutputSnapshot({ output, open }: { output: EvalOutput; open: boolean }) {
  return (
    <details open={open} className="pl-2">
      <summary className="cursor-pointer text-muted-foreground select-none">
        判分时的输出(运行状态 {output.status})
      </summary>
      <div className="mt-1 space-y-1">
        {output.error && <p className="text-destructive">错误:{output.error}</p>}
        {output.text && (
          <pre className="max-h-48 overflow-auto rounded bg-background p-2 whitespace-pre-wrap break-words">
            {output.text}
            {output.textTruncated && <span className="text-muted-foreground">…(已截断)</span>}
          </pre>
        )}
        {output.structured !== undefined && (
          <pre className="max-h-48 overflow-auto rounded bg-background p-2 font-mono">
            {JSON.stringify(output.structured, null, 2)}
          </pre>
        )}
        {output.structuredPreview && (
          <pre className="max-h-48 overflow-auto rounded bg-background p-2 font-mono break-all whitespace-pre-wrap">
            {output.structuredPreview}
            <span className="text-muted-foreground">…(结构化结果过大,已截断)</span>
          </pre>
        )}
        {!output.error &&
          !output.text &&
          output.structured === undefined &&
          !output.structuredPreview && <p className="text-muted-foreground">没有正文输出</p>}
      </div>
    </details>
  );
}
