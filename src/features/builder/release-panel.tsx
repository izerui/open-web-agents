"use client";

import { History, Rocket } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { errorText, fetchJson } from "@/lib/fetch-json";

type LineOp = { op: "same" | "add" | "del"; text: string };
type Change =
  | { path: string; kind: "added"; after: unknown }
  | { path: string; kind: "removed"; before: unknown }
  | { path: string; kind: "changed"; before: unknown; after: unknown; lines?: LineOp[] };

const short = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

/** 一次对比的结果:每处改动一行;长文本给出行级差异(只显示改动行及其上下各一行) */
export function DiffView({ title, changes }: { title: string; changes: Change[] }) {
  return (
    <div className="space-y-2 rounded border border-border bg-muted/30 p-2 text-xs">
      <p className="font-medium">{title}</p>
      {changes.length === 0 && <p className="text-muted-foreground">没有差异</p>}
      {changes.map((c) => (
        <div key={`${c.kind}:${c.path}`} className="space-y-1">
          <p className="font-mono">
            <span
              className={
                c.kind === "added"
                  ? "text-success"
                  : c.kind === "removed"
                    ? "text-destructive"
                    : "text-warning"
              }
            >
              {c.kind === "added" ? "+ 新增" : c.kind === "removed" ? "- 删除" : "~ 修改"}
            </span>{" "}
            {c.path}
          </p>
          {c.kind === "changed" && c.lines ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-1.5 font-mono text-[0.6875rem]">
              {c.lines
                .map((l, i, all) => ({ l, i, all }))
                .filter(
                  ({ l, i, all }) =>
                    l.op !== "same" || all[i - 1]?.op !== "same" || all[i + 1]?.op !== "same",
                )
                .map(({ l, i }) => (
                  <div
                    key={i}
                    className={
                      l.op === "add"
                        ? "bg-success/10 text-success"
                        : l.op === "del"
                          ? "bg-destructive/10 text-destructive line-through"
                          : "text-muted-foreground"
                    }
                  >
                    {l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}
                    {l.text}
                  </div>
                ))}
            </pre>
          ) : c.kind === "changed" ? (
            <p className="break-all font-mono text-[0.6875rem] text-muted-foreground">
              {short(c.before)} → {short(c.after)}
            </p>
          ) : (
            <p className="break-all font-mono text-[0.6875rem] text-muted-foreground">
              {short(c.kind === "added" ? c.after : c.before)}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** 某一版(或草稿)的评测结论,见服务端 eval/domain/release-gate.ts */
interface EvalBrief {
  id: string;
  passed: number;
  total: number;
  createdAt: number;
  finishedAt?: number;
}
interface EvalSummary {
  state: "no_cases" | "none" | "running" | "cases_changed" | "failed" | "passed";
  run?: EvalBrief;
  /** 草稿这份内容没评测过时,最近一次评测(配置已变化,不代表当前内容) */
  previous?: EvalBrief;
}

/** 草稿评测状态的说明;发布要求 passed */
function draftEvalText(e: EvalSummary): string {
  const r = e.run;
  switch (e.state) {
    case "passed":
      return `当前草稿评测 ${r?.passed}/${r?.total} 全部通过,可以发布`;
    case "failed":
      return `当前草稿评测 ${r?.passed}/${r?.total} 通过 —— 全部通过才能发布`;
    case "running":
      return "当前草稿的评测进行中 —— 结束并全部通过后才能发布";
    case "cases_changed":
      return `上次评测(${r?.passed}/${r?.total})之后评测用例有改动 —— 需要对草稿重新评测并全部通过`;
    case "no_cases":
      return "还没有评测用例 —— 在下方「评测」里添加用例并对草稿评测,全部通过后才能发布";
    case "none":
      return e.previous
        ? `配置已变化:上次评测(${e.previous.passed}/${e.previous.total})不代表当前草稿 —— 对草稿重新评测并全部通过后才能发布`
        : "当前草稿还没有评测过 —— 在下方「评测」里对草稿运行评测,全部通过后才能发布";
  }
}

/** 版本列表里那一版的评测标记 */
function versionEvalText(e: EvalSummary | undefined): string {
  const r = e?.run;
  switch (e?.state) {
    case "passed":
    case "failed":
      return `评测 ${r?.passed}/${r?.total}`;
    case "cases_changed":
      return `评测 ${r?.passed}/${r?.total} · 用例已改动`;
    case "running":
      return "评测中";
    case "no_cases":
      return "无用例";
    default:
      return "未评测";
  }
}

interface VersionMeta {
  version: number;
  name: string;
  note?: string;
  createdBy: string;
  createdAt: number;
}

/**
 * 版本与发布。
 *
 * 草稿随便改;接口调用和其他用户只跑【已发布】的版本。
 * 改坏了可以把发布指针指回任意旧版本(秒级生效),也可以把旧版本载入草稿接着改。
 */
export function ReleasePanel({
  agentId,
  publishedVersion,
  hasUnpublishedChanges,
  unsaved,
  draft,
  evalTick,
  onChanged,
  onRestored,
}: {
  agentId: string;
  publishedVersion: number | null;
  hasUnpublishedChanges: boolean;
  /** 表单里还有没保存的修改:发布的是已保存的草稿,先保存再发布 */
  unsaved: boolean;
  /** 已保存的草稿(重新读取后是新对象):变了就重读评测结论 */
  draft: unknown;
  /** 评测面板有变化(用例增删改、发起或结束评测)时递增:重读评测结论 */
  evalTick: number;
  onChanged: () => unknown;
  onRestored: () => unknown;
}) {
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  /** 只有能改的人拿得到;拿不到时不显示、也不据此拦发布(服务端照样会拦) */
  const [evals, setEvals] = useState<{
    draft: EvalSummary;
    versions: Record<string, EvalSummary>;
  } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  /** 正在看的对比:哪一版、跟谁比、结果 */
  const [diff, setDiff] = useState<{ key: string; title: string; changes: Change[] } | null>(null);

  async function compare(key: string, from: string, to: string, title: string) {
    if (diff?.key === key) {
      setDiff(null); // 再点一次收起
      return;
    }
    try {
      const d = await fetchJson<{ changes: Change[] }>(
        `/api/agents/${encodeURIComponent(agentId)}/versions/diff?from=${from}&to=${to}`,
      );
      setDiff({ key, title, changes: d.changes });
    } catch (e) {
      toast.error(`对比失败:${errorText(e)}`);
    }
  }

  const load = useCallback(async () => {
    try {
      const d = await fetchJson<{
        versions: VersionMeta[];
        evals?: { draft: EvalSummary; versions: Record<string, EvalSummary> };
      }>(`/api/agents/${encodeURIComponent(agentId)}/versions`);
      setVersions(d.versions);
      setEvals(d.evals ?? null);
    } catch (e) {
      setVersions([]);
      toast.error(`版本列表加载失败:${errorText(e)}`);
    }
  }, [agentId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: draft / evalTick 只是重读的信号
  useEffect(() => {
    void load();
  }, [load, draft, evalTick]);

  // 草稿评测进行中:每 3 秒重读一次(服务端读的时候顺带判分)
  useEffect(() => {
    if (evals?.draft.state !== "running") return;
    const t = setTimeout(() => void load(), 3000);
    return () => clearTimeout(t);
  }, [evals, load]);

  async function act(key: string, url: string, body: unknown, ok: string, after: () => unknown) {
    if (busy) return;
    setBusy(key);
    try {
      await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast.success(ok);
      await load();
      await after();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const base = `/api/agents/${encodeURIComponent(agentId)}`;
  const next = (versions?.[0]?.version ?? 0) + 1;
  const hasChanges = publishedVersion === null || hasUnpublishedChanges;
  const evalPassed = evals?.draft.state === "passed";
  const canPublish = !unsaved && hasChanges && evalPassed;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Rocket className="size-4" />
          版本与发布
          {publishedVersion === null ? (
            <Badge variant="secondary">未发布</Badge>
          ) : (
            <Badge variant="success">已发布 v{publishedVersion}</Badge>
          )}
          {hasUnpublishedChanges && <Badge variant="warning">草稿有未发布的修改</Badge>}
        </CardTitle>
        <CardDescription>
          {publishedVersion === null
            ? "还没有发布过:接口调用和其他用户都直接使用草稿,保存即生效。发布后,草稿的修改只有再次发布才会对他们生效。"
            : "接口调用和其他用户使用已发布版本;你在这里继续改的是草稿,试运行用草稿。调用方也可以在请求里用 version 锁定某一版。"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="版本说明(可选),如「输出加上视频时长」"
            maxLength={512}
          />
          <Button
            size="sm"
            className="shrink-0"
            disabled={!canPublish || busy !== null}
            onClick={() =>
              void act(
                "publish",
                `${base}/versions`,
                { note: note.trim() || undefined },
                `已发布 v${next}`,
                async () => {
                  setNote("");
                  await onChanged();
                },
              )
            }
          >
            {busy === "publish" ? "发布中…" : `发布为 v${next}`}
          </Button>
        </div>
        {unsaved && (
          <p className="text-xs text-muted-foreground">
            表单有未保存的修改 —— 先保存草稿再发布;评测与发布针对的都是已保存的草稿。
          </p>
        )}
        {evals && hasChanges && (
          <p
            className={`text-xs ${evalPassed ? "text-success" : "text-warning"}`}
            data-testid="draft-eval"
          >
            {draftEvalText(evals.draft)}
          </p>
        )}
        {!unsaved && publishedVersion !== null && !hasUnpublishedChanges && (
          <p className="text-xs text-muted-foreground">
            草稿与 v{publishedVersion} 相同,没有可发布的修改。
          </p>
        )}

        <div className="divide-y divide-border rounded border">
          {versions === null && <p className="p-3 text-xs text-muted-foreground">载入中…</p>}
          {versions?.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">还没有版本</p>
          )}
          {versions?.map((v) => {
            const current = v.version === publishedVersion;
            return (
              <div key={v.version} className="flex items-center gap-3 p-2 text-xs">
                <span className="w-10 shrink-0 font-mono">v{v.version}</span>
                <span className="min-w-0 flex-1 truncate">
                  {v.note || <span className="text-muted-foreground">(无说明)</span>}
                  {current && (
                    <Badge variant="success" className="ml-1.5 text-[11px]">
                      当前发布
                    </Badge>
                  )}
                </span>
                {evals && (
                  <span
                    className={`shrink-0 ${evals.versions[v.version]?.state === "passed" ? "text-success" : "text-muted-foreground"}`}
                    data-testid="version-eval"
                  >
                    {versionEvalText(evals.versions[v.version])}
                  </span>
                )}
                <span className="shrink-0 text-muted-foreground">
                  {new Date(v.createdAt).toLocaleString()}
                </span>
                {!current && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-8 shrink-0 px-2"
                    disabled={busy !== null}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `把发布版本切换到 v${v.version}？新的接口调用与其他用户的新会话会立即改用它;进行中的会话不受影响。`,
                        )
                      )
                        return;
                      void act(
                        `activate-${v.version}`,
                        `${base}/versions/${v.version}/activate`,
                        {},
                        `已切换到 v${v.version}`,
                        onChanged,
                      );
                    }}
                  >
                    <History className="size-3.5" />
                    {publishedVersion !== null && v.version < publishedVersion
                      ? "回滚到此版"
                      : "设为发布版"}
                  </Button>
                )}
                <Button
                  variant="link"
                  size="sm"
                  className="h-8 shrink-0 px-2"
                  onClick={() =>
                    void compare(
                      `draft-${v.version}`,
                      String(v.version),
                      "draft",
                      `v${v.version} → 当前草稿(已保存的)`,
                    )
                  }
                >
                  对比草稿
                </Button>
                {v.version > 1 && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-8 shrink-0 px-2"
                    onClick={() =>
                      void compare(
                        `prev-${v.version}`,
                        String(v.version - 1),
                        String(v.version),
                        `v${v.version - 1} → v${v.version}`,
                      )
                    }
                  >
                    对比上一版
                  </Button>
                )}
                <Button
                  variant="link"
                  size="sm"
                  className="h-8 shrink-0 px-2"
                  disabled={busy !== null || unsaved}
                  title={unsaved ? "表单有未保存的修改" : "用这一版的内容覆盖草稿"}
                  onClick={() => {
                    if (
                      !window.confirm(`用 v${v.version} 的内容覆盖当前草稿？已发布的版本不受影响。`)
                    )
                      return;
                    void act(
                      `restore-${v.version}`,
                      `${base}/versions/${v.version}/restore`,
                      {},
                      `已把 v${v.version} 载入草稿`,
                      onRestored,
                    );
                  }}
                >
                  载入草稿
                </Button>
              </div>
            );
          })}
        </div>
        {diff && <DiffView title={diff.title} changes={diff.changes} />}
      </CardContent>
    </Card>
  );
}
