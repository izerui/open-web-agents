"use client";

// 试聊(gaps A5):编排阶段右栏的第二个页签,用当前草稿直接对话,不开新标签。
// 会话来源记为 trial,不出现在 /chat 的会话列表里。每轮回复下方可「存为评测用例」(A6)。
// 对话流、审批条、输入框复用对话页的组件(ChatThread / ApprovalBar / Composer)。

import { AgentAvatar } from "@/components/agent-avatar";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { followRun } from "@/features/chat/follow-run";
import { ApprovalBar, type PendingQuestion } from "@/features/workbench/approval-bar";
import { Composer } from "@/features/workbench/composer";
import { ChatThread, type SubmitAnswer } from "@/features/workbench/conversation";
import { createEventBatcher } from "@/features/workbench/event-batcher";
import type { Turn } from "@/features/workbench/types";
import { updateTurnByLocalId } from "@/features/workbench/workbench.logic";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";
import type { FileUIPart } from "ai";
import { Check, Plus, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { CaseForm } from "./case-form";
import { needsRecharge } from "./designer-model";
import { caseFormFromTrial, trialCaseNote, turnAnswer, turnDurationText } from "./trial-model";
import { Tag, TextButton } from "./ui";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function dataUrlToBlob(url: string): Blob {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!match) throw new Error("附件格式不受支持");
  const mediaType = match[1] ?? "application/octet-stream";
  const payload = match[3] ?? "";
  if (!match[2]) return new Blob([decodeURIComponent(payload)], { type: mediaType });
  const binary = atob(payload);
  return new Blob([Uint8Array.from(binary, (c) => c.charCodeAt(0))], { type: mediaType });
}

async function uploadFiles(sessionId: string, files: FileUIPart[]): Promise<string[]> {
  if (files.length === 0) return [];
  const form = new FormData();
  for (const file of files) {
    const blob = dataUrlToBlob(file.url);
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error(`文件过大：${file.filename ?? "附件"}`);
    form.append("files", blob, file.filename ?? "attachment");
  }
  const res = await fetch(`/api/sessions/${sessionId}/files`, { method: "POST", body: form });
  const body = (await res.json().catch(() => null)) as { files?: string[]; error?: string } | null;
  if (!res.ok || !body?.files) throw new Error(body?.error ?? `上传文件失败(HTTP ${res.status})`);
  return body.files;
}

export function TrialPanel({
  agentId,
  agentName,
  agentIcon,
  starters,
  ready,
  modelText,
  hasInputSchema,
  beforeSend,
  onCaseSaved,
  credits,
  onTurnFinished,
}: {
  /** 草稿还没建好时为 null */
  agentId: string | null;
  agentName: string;
  agentIcon?: string | null;
  starters: string[];
  /** 名称和提示词都有了(草稿能跑) */
  ready: boolean;
  modelText: string;
  hasInputSchema: boolean;
  /** 发送前先把档案里没落盘的修改存掉;存不了返回 false */
  beforeSend: () => Promise<boolean>;
  onCaseSaved: () => void;
  /** 运行 id → 微积分(本智能体近 7 天用量);回复下的元信息显示这一轮花了多少积分 */
  credits: ReadonlyMap<string, string>;
  /** 一轮结束(页面据此刷新用量) */
  onTurnFinished: () => void;
}) {
  const finishedCb = useRef(onTurnFinished);
  finishedCb.current = onTurnFinished;
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState<Record<string, number>>({});
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const [formFor, setFormFor] = useState<string | null>(null);
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  const [awaitingTools, setAwaitingTools] = useState<string[]>([]);
  const [approvalRefresh, setApprovalRefresh] = useState(0);
  const runRef = useRef<{ abort: AbortController; runId?: string } | null>(null);
  const name = agentName.trim() || "新智能体";

  const ensureSession = useCallback(async () => {
    if (sessionRef.current) return sessionRef.current;
    if (!agentId) throw new Error("草稿还没建好");
    const d = await fetchJson<{ session: { id: string } }>("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, trial: true, title: `试聊：${name}` }),
    });
    sessionRef.current = d.session.id;
    setSessionId(d.session.id);
    return d.session.id;
  }, [agentId, name]);

  const follow = useCallback(
    async (
      id: string,
      runId: string,
      localId: string,
      abort: AbortController,
      initial?: ReadableStream<Uint8Array> | null,
    ) => {
      const patch = (fn: (t: Turn) => Turn) =>
        setTurns((all) => updateTurnByLocalId(all, localId, fn));
      const batcher = createEventBatcher((events) =>
        patch((t) => ({ ...t, events: [...t.events, ...events] })),
      );
      try {
        await followRun({
          sessionId: id,
          runId,
          push: batcher.push,
          signal: abort.signal,
          initial,
        });
      } catch (e) {
        if (!abort.signal.aborted)
          batcher.push({ kind: "result", status: "failed", summary: errorText(e), runId });
      } finally {
        batcher.flush();
        patch((t) => ({ ...t, running: false }));
        setFinished((m) => ({ ...m, [localId]: Date.now() }));
        setRunning(false);
        runRef.current = null;
        // 积分在运行结算后才进用量,稍等一下再读
        setTimeout(() => finishedCb.current(), 1500);
      }
    },
    [],
  );

  const send = useCallback(
    async (text: string, files: FileUIPart[] = []) => {
      const prompt = text.trim() || (files.length ? "请查看附件。" : "");
      if (!prompt || running) return;
      if (!(await beforeSend())) {
        toast.error("档案里还有没保存的修改（或暂停了保存），先处理好再试聊");
        return;
      }
      setRunning(true);
      const localId = crypto.randomUUID();
      setTurns((all) => [
        ...all,
        { localId, prompt, events: [], running: true, startedAt: new Date().toISOString() },
      ]);
      const abort = new AbortController();
      runRef.current = { abort };
      try {
        const id = await ensureSession();
        const uploaded = await uploadFiles(id, files);
        const runPrompt = uploaded.length
          ? `${prompt}\n\n已上传到当前工作区的附件:\n${uploaded.map((f) => `- ${f}`).join("\n")}`
          : prompt;
        const res = await fetch(`/api/sessions/${id}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: runPrompt }),
          signal: abort.signal,
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(b?.error ?? `发起运行失败(HTTP ${res.status})`);
        }
        const runId = res.headers.get("X-Run-Id");
        if (!runId || !res.body) throw new Error("运行接口没有返回事件流");
        runRef.current = { abort, runId };
        setTurns((all) =>
          updateTurnByLocalId(all, localId, (t) => ({ ...t, runId, prompt: runPrompt })),
        );
        setInput("");
        void follow(id, runId, localId, abort, res.body);
      } catch (e) {
        setTurns((all) =>
          updateTurnByLocalId(all, localId, (t) => ({
            ...t,
            running: false,
            events: [...t.events, { kind: "result", status: "failed", summary: errorText(e) }],
          })),
        );
        setFinished((m) => ({ ...m, [localId]: Date.now() }));
        setRunning(false);
        runRef.current = null;
      }
    },
    [running, beforeSend, ensureSession, follow],
  );

  /** 重新生成:回到那一轮之前的状态重来(与对话页「重跑」同一接口) */
  const rerun = useCallback(
    async (fromRunId: string, prompt: string) => {
      const id = sessionRef.current;
      if (!id || running) return;
      if (!(await beforeSend())) return;
      setRunning(true);
      const localId = crypto.randomUUID();
      setTurns((all) => [
        ...all,
        {
          localId,
          prompt,
          events: [],
          running: true,
          branchedFrom: fromRunId,
          startedAt: new Date().toISOString(),
        },
      ]);
      const abort = new AbortController();
      runRef.current = { abort };
      try {
        const branch = (mode: "rewind" | "fresh") =>
          fetch(`/api/sessions/${id}/branch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fromRunId, mode, prompt }),
          });
        let res = await branch("rewind");
        let data = (await res.json().catch(() => null)) as {
          runId?: string;
          error?: string;
          code?: string;
        } | null;
        if (res.status === 409 && data?.code === "rewind_unavailable") {
          res = await branch("fresh");
          data = (await res.json().catch(() => null)) as typeof data;
        }
        if (!res.ok || !data?.runId)
          throw new Error(data?.error ?? `重新生成失败(HTTP ${res.status})`);
        const runId = data.runId;
        runRef.current = { abort, runId };
        setTurns((all) => updateTurnByLocalId(all, localId, (t) => ({ ...t, runId })));
        await follow(id, runId, localId, abort);
      } catch (e) {
        setTurns((all) =>
          updateTurnByLocalId(all, localId, (t) => ({
            ...t,
            running: false,
            events: [...t.events, { kind: "result", status: "failed", summary: errorText(e) }],
          })),
        );
        setRunning(false);
        runRef.current = null;
      }
    },
    [running, beforeSend, follow],
  );

  const stop = useCallback(async () => {
    const h = runRef.current;
    const id = sessionRef.current;
    if (!h?.runId || !id) {
      h?.abort.abort();
      return;
    }
    await fetch(`/api/sessions/${id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: h.runId }),
    }).catch(() => {});
  }, []);

  const submitAnswer = useCallback<SubmitAnswer>(async (approvalId, body) => {
    if (!sessionRef.current) return;
    await fetchJson(`/api/sessions/${sessionRef.current}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        "decline" in body
          ? { approvalId, decision: "denied" }
          : { approvalId, decision: "approved", answers: body.answers },
      ),
    });
    setApprovalRefresh((n) => n + 1);
  }, []);

  const keyOf = (t: Turn) => t.localId ?? t.runId ?? t.prompt;

  /** 回复下那一行:耗时、积分,以及「存为评测用例」(和 token、复制、重跑同一行) */
  const renderMeta = (t: Turn) => {
    if (t.running || !agentId) return null;
    const k = keyOf(t);
    const dur = turnDurationText(t, finished[k]);
    const micro = t.runId ? credits.get(t.runId) : undefined;
    const result = t.events.find((e) => e.kind === "result");
    const failed = result?.kind === "result" && result.status !== "success";
    return (
      <>
        {dur && <span className="mr-1.5 tabular-nums">耗时 {dur}</span>}
        {micro !== undefined && (
          <span className="mr-1.5 tabular-nums">{creditsAmount(micro)} 积分</span>
        )}
        <span className="ml-auto">
          {saved.has(k) ? (
            <Tag tone="ok">
              <Check />
              已存为评测用例
            </Tag>
          ) : (
            !failed && (
              <TextButton
                className="bg-primary text-primary-foreground hover:bg-black"
                onClick={() => setFormFor(formFor === k ? null : k)}
              >
                <Plus />
                存为评测用例
              </TextButton>
            )
          )}
        </span>
      </>
    );
  };

  const renderExtra = (t: Turn) => {
    if (t.running || !agentId) return null;
    const k = keyOf(t);
    // 积分不足(发起运行就被拒,没有运行 ID,回复下那一行不出现):失败卡片下面给充值入口
    const result = t.events.find((e) => e.kind === "result");
    if (
      result?.kind === "result" &&
      result.status !== "success" &&
      needsRecharge(result.summary ?? "")
    )
      return (
        <div className="mt-1 pl-[46px] text-sm max-md:pl-0">
          <Link href="/account/billing?tab=packages" className="font-medium underline">
            去充值
          </Link>
          <span className="ml-2 text-muted-foreground">充值后回来点发送再试一次</span>
        </div>
      );
    if (formFor !== k) return null;
    const ans = turnAnswer(t);
    return (
      <div className="mt-1 pl-[46px] max-md:pl-0">
        <CaseForm
          className="mt-1.5"
          agentId={agentId}
          hasInputSchema={hasInputSchema}
          initial={caseFormFromTrial({
            prompt: t.prompt,
            answer: ans.text,
            structured: ans.structured,
            hasInputSchema,
          })}
          title="存为评测用例"
          note={trialCaseNote({ structured: ans.structured })}
          footnote="每个用例运行时会真实调用一次模型并计费"
          source="trial"
          onCancel={() => setFormFor(null)}
          onSaved={() => {
            setSaved((s) => new Set(s).add(k));
            setFormFor(null);
            toast.success("已存为评测用例");
            onCaseSaved();
          }}
        />
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {turns.length > 0 && (
        <div className="flex shrink-0 items-center justify-end border-b border-line-soft px-4 py-1.5">
          <TextButton
            disabled={running}
            onClick={() => {
              sessionRef.current = null;
              setSessionId(null);
              setTurns([]);
              setSaved(new Set());
              setFormFor(null);
            }}
          >
            <RotateCcw />
            新开一段试聊
          </TextButton>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {turns.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8 text-center">
            <AgentAvatar id={agentId ?? "new-agent"} icon={agentIcon} size={64} />
            <div className="mt-2.5 font-display text-[22px]">和「{name}」试聊</div>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              用的是当前草稿，不影响发布版；不开新标签。觉得回答对，就把它存成评测用例。
            </p>
            {ready && agentId ? (
              <div className="mt-2 flex flex-wrap justify-center gap-1.5">
                {starters.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    className="rounded-full border border-border bg-card px-3 py-1.5 text-[13px] hover:bg-[#F2F0EA] max-md:min-h-11"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                先在档案里写好名称和提示词，才能试聊。
              </p>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1">
            <ChatThread
              key={sessionId ?? "trial"}
              turns={turns}
              agentName={`${name}（草稿）`}
              agentId={agentId ?? "new-agent"}
              agentIcon={agentIcon}
              onRerunAction={(runId, prompt) => void rerun(runId, prompt)}
              onAnswerAction={(text) => void send(text)}
              pendingQuestions={pendingQuestions}
              submitAnswerAction={submitAnswer}
              awaitingTools={awaitingTools}
              renderTurnExtra={renderExtra}
              renderTurnMeta={renderMeta}
            />
          </div>
        )}
      </div>
      <div className="shrink-0 pt-1">
        <ApprovalBar
          key={sessionId ?? "none"}
          sessionId={sessionId}
          running={running}
          onQuestionsChange={setPendingQuestions}
          onApprovalsChange={setAwaitingTools}
          refreshKey={approvalRefresh}
        />
        <Composer
          input={input}
          onInputChangeAction={setInput}
          running={running}
          blocked={!ready || !agentId}
          placeholder={
            ready && agentId ? `用草稿问一句（${modelText}，费用记在你名下）` : "先写好名称和提示词"
          }
          onSubmitAction={(m: PromptInputMessage) => send(m.text, m.files)}
          onStopAction={() => void stop()}
          commands={[]}
          queued={[]}
          onUnqueueAction={() => {}}
          contextUsed={0}
          totalProcessed={null}
        />
      </div>
    </div>
  );
}
