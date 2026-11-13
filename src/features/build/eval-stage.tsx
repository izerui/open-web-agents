"use client";

// 评测阶段:说明、结论横幅、运行目标、逐个运行的进度、用例卡(通过 / 未通过 / 运行中 / 未运行)、
// 失败展开输出快照与原因、「让设计器修复」(A7)、用例表单、运行确认含花费预估(A9)、历史评测与详情。
// 判分、轮询与接口沿用原 EvalPanel。

import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { EMPTY_FORM, type EvalAssertionsBody, formFromCase } from "@/features/builder/eval-form";
import { creditsText } from "@/features/models/model-shared";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatTime } from "@/lib/format-time";
import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";
import { cn } from "@/lib/utils";
import {
  Check,
  Info,
  Loader2,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type EvalSummary, type Stage, assertionText } from "./build-model";
import { CaseForm } from "./case-form";
import { type EvalOutputLite, evalFixPrompt } from "./design-sections";
import { Banner, StageTitle, SubHead, Tag, TextButton } from "./ui";
import type { VersionMeta } from "./use-build-data";

export interface EvalCase {
  id: string;
  name: string;
  input: unknown;
  assertions: EvalAssertionsBody;
  /** 来源:trial = 构建页试聊里存进来的 */
  source?: "manual" | "trial";
}

interface EvalRun {
  id: string;
  agentVersion?: number;
  configHash?: string;
  status: "running" | "done";
  total: number;
  passed: number;
  failed: number;
  createdAt: number;
  matchesDraft?: boolean;
  matchesVersions?: number[];
  casesChanged?: boolean;
}

export interface EvalResult {
  caseId: string;
  caseName: string;
  status: "pending" | "passed" | "failed" | "error";
  failures?: string[];
  output?: EvalOutputLite;
  taskId?: string;
  costMicroUsd?: number;
  durationMs?: number;
}

/** 让设计器修复这些未通过的用例:拼给设计器的那句话 */
export function fixPromptFrom(cases: readonly EvalCase[], results: readonly EvalResult[]): string {
  return evalFixPrompt(
    results.map((r) => {
      const c = cases.find((x) => x.id === r.caseId);
      return {
        caseName: r.caseName,
        input: c?.input ?? "",
        assertions: c ? assertionText(c.assertions) : "",
        failures: r.failures,
        output: r.output,
      };
    }),
  );
}

/** 用例这次运行的花费、耗时(花费用积分;用量里没有这条运行就不显示) */
function resultMeta(r: EvalResult, credits: ReadonlyMap<string, string>): string {
  const micro = r.taskId ? credits.get(r.taskId) : undefined;
  return [
    r.status === "error" ? "未能运行" : null,
    micro !== undefined ? `${creditsAmount(micro)} 积分` : null,
    r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)}s` : null,
  ]
    .filter(Boolean)
    .join("，");
}

export function EvalStage({
  agentId,
  publishedVersion,
  versions,
  draftEval,
  hasInputSchema,
  beforeRun,
  onChanged,
  onFix,
  goStage,
  credits,
  onProgress,
  askRun: askRunToken = 0,
}: {
  agentId: string | null;
  publishedVersion: number | null;
  versions: VersionMeta[] | null;
  draftEval: EvalSummary | null;
  hasInputSchema: boolean;
  /** 运行前先存档案(评测跑的是自动保存后的草稿) */
  beforeRun: () => Promise<boolean>;
  onChanged: () => void;
  onFix: (prompt: string) => void;
  goStage: (s: Stage) => void;
  /** 运行 id → 微积分(本智能体近 7 天用量) */
  credits: ReadonlyMap<string, string>;
  /** 对草稿的评测在跑时报告进度(页头徽标「运行中 x/n」) */
  onProgress?: (p: { done: number; total: number } | null) => void;
  /** 变化(且非 0)时对草稿弹出运行确认 —— 设计器「重新运行评测」 */
  askRun?: number;
}) {
  const confirmDialog = useConfirm();
  const [history, setHistory] = useState<{ run: EvalRun; results: EvalResult[] } | null>(null);
  const base = agentId ? `/api/agents/${encodeURIComponent(agentId)}/evals` : "";
  const [cases, setCases] = useState<EvalCase[] | null>(null);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [detail, setDetail] = useState<{ run: EvalRun; results: EvalResult[] } | null>(null);
  const [target, setTarget] = useState("draft");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [openCase, setOpenCase] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<{
    estimate: {
      avgMicroCredits: string | null;
      totalMicroCredits: string | null;
      samples: number;
    } | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const notify = useRef(onChanged);
  notify.current = onChanged;

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const [c, r] = await Promise.all([
        fetchJson<{ cases: EvalCase[] }>(`${base}/cases`),
        fetchJson<{ runs: EvalRun[] }>(`${base}/runs`),
      ]);
      setCases(c.cases);
      setRuns(r.runs);
      return r.runs;
    } catch (e) {
      setCases([]);
      toast.error(`评测加载失败：${errorText(e)}`);
    }
  }, [base]);

  const openRun = useCallback(
    async (id: string) => {
      try {
        setDetail(await fetchJson<{ run: EvalRun; results: EvalResult[] }>(`${base}/runs/${id}`));
      } catch (e) {
        toast.error(`读取评测失败：${errorText(e)}`);
      }
    },
    [base],
  );

  // 进来时读用例与历史,默认展示最近一次对草稿的评测
  useEffect(() => {
    void load().then((r) => {
      const latest = r?.find((x) => x.agentVersion === undefined) ?? r?.[0];
      if (latest) void openRun(latest.id);
    });
  }, [load, openRun]);

  // 正在跑的评测每 2 秒刷新一次(读的时候服务端顺带判分);跑完刷新历史与发布结论
  useEffect(() => {
    if (!detail || detail.run.status !== "running") return;
    const t = setTimeout(() => void openRun(detail.run.id), 2000);
    return () => clearTimeout(t);
  }, [detail, openRun]);
  const doneRef = useRef<string | null>(null);
  useEffect(() => {
    if (detail?.run.status === "done" && doneRef.current !== detail.run.id) {
      doneRef.current = detail.run.id;
      void load();
      notify.current();
    }
  }, [detail, load]);

  const byCase = useMemo(
    () => new Map((detail?.results ?? []).map((r) => [r.caseId, r])),
    [detail],
  );
  const shownVersion = detail?.run.agentVersion;
  const running = detail?.run.status === "running";
  const n = cases?.length ?? 0;
  const failedResults = (detail?.results ?? []).filter(
    (r) => r.status === "failed" || r.status === "error",
  );
  const done = (detail?.results ?? []).filter((r) => r.status !== "pending").length;

  const progress = useRef(onProgress);
  progress.current = onProgress;
  const draftRunning = running && shownVersion === undefined;
  const total = detail?.run.total ?? 0;
  useEffect(() => {
    progress.current?.(draftRunning ? { done, total } : null);
  }, [draftRunning, done, total]);
  useEffect(() => () => progress.current?.(null), []);

  function fix(results: EvalResult[]) {
    if (results.length) onFix(fixPromptFrom(cases ?? [], results));
  }

  async function openHistory(id: string) {
    try {
      setHistory(await fetchJson<{ run: EvalRun; results: EvalResult[] }>(`${base}/runs/${id}`));
    } catch (e) {
      toast.error(`读取评测失败：${errorText(e)}`);
    }
  }

  async function askRun() {
    if (!n || busy) return;
    let estimate = null;
    try {
      estimate = await fetchJson<{
        avgMicroCredits: string | null;
        totalMicroCredits: string | null;
        samples: number;
      }>(`${base}/estimate`);
    } catch {
      estimate = null;
    }
    setConfirm({ estimate });
  }

  // 「重新运行评测」:用例读到之后对草稿弹出运行确认,同一个请求只弹一次
  const askedRef = useRef(0);
  const askRef = useRef(askRun);
  askRef.current = askRun;
  useEffect(() => {
    if (!askRunToken || askedRef.current === askRunToken || cases === null) return;
    askedRef.current = askRunToken;
    if (running) return;
    setTarget("draft");
    void askRef.current();
  }, [askRunToken, cases, running]);

  async function run() {
    setBusy(true);
    try {
      if (target === "draft" && !(await beforeRun())) {
        throw new Error("档案里还有没保存的修改（或暂停了保存），评测跑的是已保存的草稿");
      }
      const r = await fetchJson<{ run: EvalRun }>(`${base}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: target === "draft" ? "draft" : Number(target) }),
      });
      setConfirm(null);
      await load();
      await openRun(r.run.id);
      notify.current();
    } catch (e) {
      toast.error(`发起评测失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function deleteCase(c: EvalCase) {
    confirmDialog.ask({
      title: `删除用例「${c.name}」？`,
      description: "历史评测里的记录保留；草稿的评测结论会作废，需要重跑。",
      confirmLabel: "删除用例",
      destructive: true,
      onConfirm: async () => {
        try {
          await fetchJson(`${base}/cases/${c.id}`, { method: "DELETE" });
          await load();
          notify.current();
        } catch (e) {
          toast.error(`删除失败：${errorText(e)}`);
        }
      },
    });
  }

  if (!agentId) {
    return (
      <div>
        <StageTitle title="评测" />
        <Banner icon={<Info />}>填好名称和提示词、草稿自动建好后就能添加用例和运行评测。</Banner>
      </div>
    );
  }

  let banner: React.ReactNode;
  if (cases && n === 0) {
    banner = (
      <Banner icon={<Info />}>
        还没有用例。在编排的「试聊」里点回复下方的「存为评测用例」，或在这里手动添加。发布至少需要 1
        个用例。
      </Banner>
    );
  } else if (running) {
    banner = (
      <Banner icon={<Loader2 className="animate-spin" />}>
        正在对<b>{shownVersion === undefined ? "草稿" : `v${shownVersion}`}</b>运行{" "}
        {detail?.run.total} 个用例，逐个真实调用模型，每 2 秒刷新一次。
      </Banner>
    );
  } else if (shownVersion !== undefined) {
    banner = (
      <Banner
        icon={<Info />}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const d = runs.find((r) => r.agentVersion === undefined);
              if (d) void openRun(d.id);
              else setDetail(null);
            }}
          >
            看草稿的结果
          </Button>
        }
      >
        下面显示的是对 <b>v{shownVersion}</b> 的评测结果，<b>不影响</b>
        发布门槛；发布看的是对当前草稿的评测。
      </Banner>
    );
  } else if (draftEval?.state === "passed") {
    banner = (
      <Banner
        tone="ok"
        icon={<Check />}
        action={
          <Button size="sm" variant="success" onClick={() => goStage("publish")}>
            去上线清单
          </Button>
        }
      >
        <b>
          当前草稿 {draftEval.run?.total}/{draftEval.run?.total} 全部通过。
        </b>
        可以发布了。
      </Banner>
    );
  } else if (draftEval?.state === "failed") {
    banner = (
      <Banner
        tone="warn"
        icon={<TriangleAlert />}
        action={
          failedResults.length > 0 && (
            <Button size="sm" onClick={() => fix(failedResults)}>
              <Sparkles />
              让设计器修复
            </Button>
          )
        }
      >
        <b>
          {draftEval.run?.passed}/{draftEval.run?.total} 通过，
          {(draftEval.run?.total ?? 0) - (draftEval.run?.passed ?? 0)} 个未通过。
        </b>
        发布要求当前草稿全部通过。
      </Banner>
    );
  } else if (draftEval?.state === "cases_changed") {
    banner = (
      <Banner tone="warn" icon={<TriangleAlert />}>
        <b>用例改动过，之前的评测结论作废。</b>对当前草稿重跑一次。
      </Banner>
    );
  } else if (draftEval?.state === "none" && draftEval.previous) {
    banner = (
      <Banner tone="warn" icon={<TriangleAlert />}>
        <b>配置已变化，之前的评测结论作废。</b>对当前草稿重跑一次。
      </Banner>
    );
  } else if (n > 0) {
    banner = <Banner icon={<Info />}>{n} 个用例还没对当前草稿运行过。</Banner>;
  }

  const newForm = { ...EMPTY_FORM, inputIsJson: hasInputSchema };

  return (
    <div>
      <StageTitle
        title="评测"
        desc="每个用例会真实调用一次模型，费用记在你名下。发布要求：对当前草稿的评测全部通过（至少 1 个用例），且之后没改过配置或用例。"
      />
      {banner}
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <label htmlFor="eval-target" className="shrink-0 text-sm text-muted-foreground">
          运行目标
        </label>
        <NativeSelect
          id="eval-target"
          aria-label="评测哪个版本"
          className="w-[210px]"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="draft">当前草稿（自动保存）</option>
          {(versions ?? []).map((v) => (
            <option key={v.version} value={String(v.version)}>
              v{v.version}
              {v.version === publishedVersion ? "（发布版）" : ""}
            </option>
          ))}
        </NativeSelect>
        <div
          className="h-1.5 w-24 overflow-hidden rounded-[3px] bg-[#ECEAE3]"
          aria-hidden
          title={`评测进度 ${done}/${detail?.run.total ?? n}`}
        >
          <i
            className="block h-full bg-success transition-[width]"
            style={{ width: `${detail?.run.total ? (done / detail.run.total) * 100 : 0}%` }}
          />
        </div>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          <Plus />
          添加用例
        </Button>
        <Button size="sm" disabled={!n || busy || running} onClick={() => void askRun()}>
          {running ? <Loader2 className="animate-spin" /> : <Play />}
          {running ? "运行中…" : `运行全部 ${n} 个用例`}
        </Button>
      </div>

      {editing === "new" && (
        <CaseForm
          className="mb-3 bg-card"
          agentId={agentId}
          hasInputSchema={hasInputSchema}
          initial={newForm}
          title="添加用例"
          note="评测跑的是自动保存后的草稿"
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
            notify.current();
          }}
        />
      )}

      {cases === null && <p className="text-sm text-muted-foreground">载入中…</p>}
      {cases?.map((c) => {
        if (editing === c.id) {
          return (
            <CaseForm
              key={c.id}
              className="mb-2 bg-card"
              agentId={agentId}
              caseId={c.id}
              hasInputSchema={hasInputSchema}
              initial={formFromCase(c)}
              title="编辑用例"
              note="评测跑的是自动保存后的草稿"
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                void load();
                notify.current();
              }}
            />
          );
        }
        const r = byCase.get(c.id);
        const st = r?.status;
        const bad = st === "failed" || st === "error";
        const open = bad ? openCase[c.id] !== false : openCase[c.id] === true;
        const canOpen = st === "passed" || bad;
        return (
          <div
            key={c.id}
            className={cn(
              "mb-2 overflow-hidden rounded-[14px] border border-border transition-colors",
              st === "passed" && "border-[#CFE0D3]",
              bad && "border-[#EBC5BB]",
            )}
          >
            <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
              <span className="grid size-[18px] shrink-0 place-items-center">
                {st === "passed" ? (
                  <span className="grid size-[18px] place-items-center rounded-full bg-success text-white">
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                ) : bad ? (
                  <span className="grid size-[18px] place-items-center rounded-full bg-destructive-soft text-destructive">
                    <X className="size-3" strokeWidth={3} />
                  </span>
                ) : st === "pending" ? (
                  <Loader2 className="size-[18px] animate-spin text-muted-foreground" />
                ) : (
                  <span className="size-[18px] rounded-full border-[1.5px] border-[#C9C4B8]" />
                )}
              </span>
              <button
                type="button"
                disabled={!canOpen}
                aria-expanded={canOpen ? open : undefined}
                onClick={() => setOpenCase((m) => ({ ...m, [c.id]: !open }))}
                className="min-w-0 flex-1 text-left disabled:cursor-default max-md:basis-[calc(100%-34px)]"
              >
                <div className="flex flex-wrap items-center gap-2 font-semibold">
                  {c.name}
                  {c.source === "trial" && (
                    <Tag line className="font-normal">
                      来自试聊
                    </Tag>
                  )}
                </div>
                <div className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {assertionText(c.assertions)}
                </div>
              </button>
              <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground max-md:ml-[30px] max-md:flex-1">
                {r && st !== "pending"
                  ? resultMeta(r, credits)
                  : st === "pending"
                    ? "运行中"
                    : "未运行"}
              </span>
              {bad && (
                <Button size="sm" onClick={() => r && fix([r])}>
                  让设计器修复
                </Button>
              )}
              <TextButton disabled={running} onClick={() => setEditing(c.id)}>
                <Pencil />
                编辑
              </TextButton>
              <TextButton
                aria-label={`删除用例 ${c.name}`}
                disabled={running}
                onClick={() => deleteCase(c)}
              >
                <Trash2 />
              </TextButton>
            </div>
            {open && r && canOpen && (
              <div className="px-3.5 pb-3.5 pl-11 text-sm max-md:pl-3.5">
                {bad ? (
                  <div className="text-destructive">
                    {(r.failures?.length ? r.failures : [r.output?.error ?? "未通过"]).map((x) => (
                      <div key={x}>{x}</div>
                    ))}
                  </div>
                ) : (
                  <div className="text-success-text">全部断言通过</div>
                )}
                {r.output && (
                  <>
                    <div className="mt-1.5 text-xs text-muted-foreground">
                      判分时的输出快照（运行状态 {r.output.status}）
                    </div>
                    <pre className="my-2 max-h-56 overflow-auto rounded-[10px] bg-[#F6F5F1] px-3 py-2.5 font-mono text-[13px] whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {r.output.structured !== undefined
                        ? JSON.stringify(r.output.structured, null, 2)
                        : (r.output.structuredPreview ??
                          r.output.text ??
                          r.output.error ??
                          "没有正文输出")}
                      {r.output.textTruncated && "…（已截断）"}
                    </pre>
                  </>
                )}
                <span className="text-xs text-muted-foreground">
                  {r.taskId && <>运行 ID {r.taskId}，</>}
                  <button type="button" className="underline" onClick={() => goStage("runs")}>
                    在运行记录里看
                  </button>
                </span>
              </div>
            )}
          </div>
        );
      })}

      <SubHead>
        <span>
          历史评测
          <span className="ml-2 font-normal text-muted-foreground">
            点一行看详情，不改上面的列表
          </span>
        </span>
      </SubHead>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line-soft text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-normal">目标</th>
              <th className="px-3 py-2 font-normal">配置哈希</th>
              <th className="px-3 py-2 font-normal">标记</th>
              <th className="px-3 py-2 font-normal">结果</th>
              <th className="px-3 py-2 font-normal">时间</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">
                  还没有评测记录
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr
                key={r.id}
                tabIndex={0}
                onClick={() => void openHistory(r.id)}
                onKeyDown={(e) => e.key === "Enter" && void openHistory(r.id)}
                className={cn(
                  "cursor-pointer border-b border-line-soft last:border-0 hover:bg-[#FAF9F6]",
                  detail?.run.id === r.id && "bg-[#F6F5F1]",
                )}
              >
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {r.agentVersion !== undefined ? `v${r.agentVersion}` : "草稿"}
                </td>
                <td className="px-3 py-2.5 font-mono text-[13px]" title={r.configHash}>
                  {r.configHash?.slice(0, 7) ?? "—"}
                </td>
                <td className="px-3 py-2.5" data-testid="eval-run-match">
                  <span className="flex flex-wrap gap-1">
                    {r.matchesDraft && <Tag tone="ok">= 当前草稿</Tag>}
                    {r.matchesVersions?.map((v) => (
                      <Tag key={v}>= v{v}</Tag>
                    ))}
                    {!r.matchesDraft && !r.matchesVersions?.length && (
                      <Tag tone="warn">配置已变化</Tag>
                    )}
                    {r.casesChanged && <Tag tone="warn">用例已改动</Tag>}
                  </span>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {r.status === "running"
                    ? "运行中…"
                    : `${r.passed}/${r.total}（${Math.round((r.passed / Math.max(1, r.total)) * 100)}%）`}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">
                  {formatTime(r.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={history !== null} onOpenChange={(o) => !o && setHistory(null)}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {history?.run.agentVersion !== undefined ? `v${history?.run.agentVersion}` : "草稿"}
              的评测，{history ? formatTime(history.run.createdAt) : ""}
            </DialogTitle>
            <DialogDescription>
              {history?.run.status === "running"
                ? "还在运行"
                : `${history?.run.passed}/${history?.run.total} 通过`}
              {history?.run.configHash ? `，配置 ${history.run.configHash.slice(0, 7)}` : ""}
              {history?.run.casesChanged ? "，之后用例改动过" : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-hidden rounded-xl border border-border">
            {(history?.results ?? []).map((r) => {
              const bad = r.status === "failed" || r.status === "error";
              return (
                <div
                  key={r.caseId}
                  className="flex items-start gap-2.5 border-b border-line-soft px-3 py-2.5 text-sm last:border-0"
                >
                  <span className="mt-0.5">
                    {r.status === "passed" ? (
                      <span className="grid size-[18px] place-items-center rounded-full bg-success text-white">
                        <Check className="size-3" strokeWidth={3} />
                      </span>
                    ) : bad ? (
                      <span className="grid size-[18px] place-items-center rounded-full bg-destructive-soft text-destructive">
                        <X className="size-3" strokeWidth={3} />
                      </span>
                    ) : (
                      <Loader2 className="size-[18px] animate-spin text-muted-foreground" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{r.caseName}</div>
                    {bad && (
                      <div className="text-[13px] text-destructive [overflow-wrap:anywhere]">
                        {(r.failures?.length ? r.failures : [r.output?.error ?? "未通过"]).join(
                          "；",
                        )}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {r.status === "pending" ? "运行中" : resultMeta(r, credits)}
                  </span>
                </div>
              );
            })}
            {history && history.results.length === 0 && (
              <div className="px-3 py-2.5 text-sm text-muted-foreground">没有用例结果</div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                const id = history?.run.id;
                setHistory(null);
                if (id) void openRun(id);
              }}
            >
              在上方列表里展开
            </Button>
            <Button onClick={() => setHistory(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>运行评测</DialogTitle>
            <DialogDescription>
              对{target === "draft" ? "当前草稿" : `v${target}`}跑 {n}{" "}
              个用例：每个用例会真实调用一次模型，花费记在你名下。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-xl bg-[#F6F5F1] px-3.5 py-3 text-sm">
            {confirm?.estimate?.totalMicroCredits ? (
              <>
                预计约 <b>{creditsText(confirm.estimate.totalMicroCredits)} 积分</b>
                <div className="mt-0.5 text-[13px] text-muted-foreground">
                  按同一模型最近 {confirm.estimate.samples} 次运行的平均实扣（每次约{" "}
                  {creditsText(confirm.estimate.avgMicroCredits ?? "0")}{" "}
                  积分）乘以用例数估算，实际以运行结算为准。
                </div>
              </>
            ) : (
              <span className="text-muted-foreground">
                这个模型最近还没有可参考的运行花费，暂时估不出总价；每个用例都会按实际用量计费。
              </span>
            )}
          </div>
          {target === "draft" && (
            <p className="m-0 text-[13px] text-muted-foreground">
              评测跑的是自动保存后的草稿；档案里没落盘的修改会先保存。
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void run()}>
              {busy ? <Loader2 className="animate-spin" /> : <Play />}
              开始运行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmDialog.dialog}
    </div>
  );
}
