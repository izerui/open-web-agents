"use client";

// Skills / MCP 来源:从你能编辑的其他智能体引用技能包与 MCP(原 AI 编辑右栏的资源引用)。
// 引用记在设计会话里;勾选后设计器把它列成「能力」节的待确认改动,应用时内容复制进本智能体。

import { AgentAvatar } from "@/components/agent-avatar";
import { NativeSelect } from "@/components/ui/native-select";
import { McpCheck } from "@/features/builder/mcp-check";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { SubHead, TextButton, inputMono } from "./ui";
import type { Designer } from "./use-designer";

export function DesignSources({
  designer,
  sources,
  inlineSkills,
  inlineMcps,
  canStart,
}: {
  designer: Designer;
  sources: { id: string; name: string; icon?: string }[];
  inlineSkills: string[];
  inlineMcps: string[];
  /** 智能体已建好(新建且没保存时还不能引用) */
  canStart: boolean;
}) {
  const v = designer.view;
  // 勾选要等设计会话接口返回才落到草稿里;请求期间先按用户的操作显示,失败或返回后以草稿为准
  const [pendingRefs, setPendingRefs] = useState<Record<string, boolean>>({});
  const target = v?.targetId;
  const ids = (v?.resourceAgentIds ?? []).filter((id) => id !== target);
  const resources = v?.resources ?? [];
  const draft = v?.draft;
  const disabled = designer.blocked || v?.legacy === true;
  const avail = sources.filter((s) => s.id !== target && !ids.includes(s.id));
  const nameOf = (id: string) =>
    sources.find((s) => s.id === id)?.name ??
    resources.find((r) => r.agentId === id)?.agentName ??
    id;

  return (
    <div className="mt-[18px]">
      <SubHead
        right={
          <NativeSelect
            aria-label="添加资源来源"
            className="h-8 w-52 text-[13px]"
            value=""
            disabled={!canStart || disabled || avail.length === 0}
            onChange={(e) => {
              if (e.target.value)
                void designer.changeSources([...(v?.resourceAgentIds ?? []), e.target.value]);
            }}
          >
            <option value="">{avail.length ? "添加来源智能体…" : "没有更多可选的智能体"}</option>
            {avail.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}（{s.id}）
              </option>
            ))}
          </NativeSelect>
        }
      >
        Skills / MCP 来源
      </SubHead>
      <p className="-mt-1 mb-2 text-[13px] text-muted-foreground">
        从你能编辑的其他智能体引用技能包和
        MCP。勾选后智能体设计器会把它列成「能力」的待确认改动，应用到草稿时把内容复制进本智能体；和本智能体里同名的定义冲突，不能同时引用。
      </p>
      {!canStart && (
        <p className="m-0 text-sm text-muted-foreground">填好名称和提示词、草稿建好后就能引用。</p>
      )}
      {canStart && v?.legacy && (
        <p className="m-0 text-sm text-muted-foreground">
          当前设计记录没有保存基线，先在智能体设计器里「载入当前草稿」。
        </p>
      )}
      {canStart && ids.length === 0 && (
        <p className="m-0 text-sm text-muted-foreground">还没有引用其他智能体的资源。</p>
      )}
      {ids.map((id) => {
        const mine = resources.filter((r) => r.agentId === id);
        const used = mine.filter(
          (r) => draft?.skillRefs.includes(r.ref) || draft?.mcpRefs.includes(r.ref),
        ).length;
        return (
          <div key={id} className="mb-2 rounded-xl border border-border bg-card">
            <div className="flex min-h-12 flex-wrap items-center gap-2.5 px-3 py-2.5">
              <AgentAvatar
                id={id}
                icon={sources.find((s) => s.id === id)?.icon ?? null}
                size={24}
              />
              <b>{nameOf(id)}</b>
              <span className={cn("text-xs text-muted-foreground", inputMono)}>{id}</span>
              <span className="flex-1" />
              <span className="text-xs text-muted-foreground">已引用 {used} 项</span>
              <TextButton
                disabled={disabled}
                onClick={() =>
                  void designer.changeSources((v?.resourceAgentIds ?? []).filter((x) => x !== id))
                }
              >
                移除来源
              </TextButton>
            </div>
            <div className="grid gap-3 border-t border-line-soft px-3.5 pt-2.5 pb-3 sm:grid-cols-2">
              {(["skill", "mcp"] as const).map((kind) => {
                const list = mine.filter((r) => r.kind === kind);
                const inline = kind === "skill" ? inlineSkills : inlineMcps;
                const refs = kind === "skill" ? (draft?.skillRefs ?? []) : (draft?.mcpRefs ?? []);
                return (
                  <div key={kind} className="min-w-0">
                    <div className="mb-1 text-xs text-muted-foreground">
                      {kind === "skill" ? "Skills" : "MCP"}
                    </div>
                    {list.length === 0 && (
                      <p className="m-0 text-[13px] text-muted-foreground">暂无可用资源</p>
                    )}
                    {list.map((r) => {
                      const saved = refs.includes(r.ref);
                      const on = pendingRefs[r.ref] ?? saved;
                      const conflict = inline.includes(r.name) && !on;
                      return (
                        <div
                          key={r.ref}
                          className="border-b border-dashed border-line-soft py-1.5 last:border-0"
                        >
                          <label
                            className={cn(
                              "flex items-start gap-2 text-[13px]",
                              conflict ? "cursor-not-allowed" : "cursor-pointer",
                            )}
                            title={
                              conflict
                                ? `和本智能体的同名${kind === "skill" ? "技能包" : " MCP"}冲突`
                                : undefined
                            }
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5 size-4 shrink-0 accent-[#1C1C1C]"
                              checked={on}
                              disabled={disabled || conflict}
                              onChange={(e) => {
                                const next = e.target.checked;
                                setPendingRefs((p) => ({ ...p, [r.ref]: next }));
                                void designer
                                  .toggleRef(kind, r.ref, next)
                                  .finally(() => setPendingRefs(({ [r.ref]: _, ...rest }) => rest));
                              }}
                            />
                            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                              <span
                                className={cn(inputMono, conflict && "text-[#8A857A] line-through")}
                              >
                                {r.name}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {conflict
                                  ? `和本智能体的同名${kind === "skill" ? "技能包" : " MCP"}冲突，不能引用`
                                  : (r.description ?? r.agentName)}
                              </span>
                            </span>
                          </label>
                          {kind === "mcp" && saved && v && (
                            <div className="mt-1 pl-6">
                              <McpCheck
                                name={r.name}
                                resetKey={`${r.ref}:${v.revision ?? ""}`}
                                requestAction={() => ({
                                  url: `/api/agents/design/${designer.sessionId}/mcp-check`,
                                  body: { name: r.name },
                                })}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
