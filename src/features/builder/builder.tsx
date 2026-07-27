"use client";

import { KnowledgePanel } from "@/features/builder/knowledge-panel";
import { SharePanel } from "@/features/builder/share-panel";
import type { AssistantSummary } from "@/features/workbench/types";
import { PERMISSION_MODES, type PermissionMode } from "@/lib/shared";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const SCHEMA_EXAMPLE = `{
  "type": "object",
  "properties": {
    "verdict": { "type": "string", "enum": ["pass", "needs_work"] },
    "issues": { "type": "array", "items": { "type": "string" } },
    "score": { "type": "integer", "minimum": 0, "maximum": 100 }
  },
  "required": ["verdict", "issues", "score"],
  "additionalProperties": false
}`;

const INPUT_SCHEMA_EXAMPLE = `{
  "type": "object",
  "properties": {
    "topic": { "type": "string", "minLength": 1 },
    "level": { "type": "string", "enum": ["basic", "advanced"] }
  },
  "required": ["topic"],
  "additionalProperties": false
}`;

interface McpDraft {
  /** 稳定行 id。用数组索引作 key 会在删除中间行时把编辑状态错位到别行。 */
  uid: string;
  name: string;
  type: "http" | "stdio";
  url: string;
}

function newMcpRow(): McpDraft {
  return { uid: crypto.randomUUID(), name: "", type: "http", url: "" };
}

/** 子代理:让助手把一类子任务交给一个带专属提示词的下级去做。 */
interface SubagentDraft {
  uid: string;
  name: string;
  /** 【何时】用它 —— 主 agent 靠这句话决定要不要把子任务交出去 */
  description: string;
  prompt: string;
}

function newSubagentRow(): SubagentDraft {
  return { uid: crypto.randomUUID(), name: "", description: "", prompt: "" };
}

interface Draft {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  maxTurns: number;
  inputSchemaText: string;
  outputSchemaText: string;
  webhookUrl: string;
  /** 工具白名单(逗号分隔);留空 = 不限制 */
  toolsText: string;
  /** 逗号/换行分隔的技能名 */
  skillsText: string;
  mcpServers: McpDraft[];
  subagents: SubagentDraft[];
  /** 需审批的工具名(逗号分隔) */
  approvalToolsText: string;
  /** 需审批的命令模式(逗号分隔) */
  approvalPatternsText: string;
  /** 权限模式;按场景选,不是安全等级 */
  permissionMode: PermissionMode;
}

const EMPTY: Draft = {
  id: "",
  name: "",
  description: "",
  systemPrompt: "",
  model: "sonnet",
  maxTurns: 20,
  inputSchemaText: "",
  outputSchemaText: "",
  webhookUrl: "",
  toolsText: "",
  skillsText: "",
  mcpServers: [],
  subagents: [],
  approvalToolsText: "",
  approvalPatternsText: "",
  permissionMode: "default",
};

/**
 * 权限模式的中文名与用法。
 *
 * 名字对齐 Claude 官方客户端的菜单(Ask permissions / Accept edits / Plan mode /
 * Auto mode / Bypass permissions)—— 直接把 `default`、`dontAsk` 这种 SDK 内部值
 * 摆给用户看,没人知道该选哪个。
 */
const PERMISSION_MODE_META: Record<PermissionMode, { label: string; hint: string }> = {
  default: {
    label: "询问权限",
    hint: "有人盯着的 web 对话:命中下面的审批规则时弹确认",
  },
  acceptEdits: { label: "自动接受编辑", hint: "文件改动自动放行,其余照常" },
  plan: { label: "规划模式", hint: "只探索和出方案,不动源文件" },
  auto: { label: "自动判定", hint: "由模型分类器逐个判定(需要特定配置支持)" },
  bypassPermissions: {
    label: "跳过权限检查",
    hint: "接口调用等无人值守场景:不问人。路径围栏与工具白名单仍然生效",
  },
  dontAsk: {
    label: "从不询问",
    hint: "白名单之外一律拒绝,不弹任何确认(官方客户端未暴露此模式)",
  },
};

/** 技能名按逗号/换行/空格拆分,去空去重 —— 用户怎么贴都能用 */
function parseSkills(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，\s\n]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

export function Builder() {
  const [list, setList] = useState<AssistantSummary[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(
    () =>
      fetch("/api/assistants")
        .then((r) => r.json())
        .then((d: { assistants?: AssistantSummary[] }) => setList(d.assistants ?? [])),
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // outputSchema 的合法性即时反馈 —— 它是对外接口契约,写错了整个助手就不可用
  const schemaText = draft.outputSchemaText.trim();
  let schemaError: string | null = null;
  let parsedSchema: Record<string, unknown> | undefined;
  if (schemaText) {
    try {
      const v = JSON.parse(schemaText);
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        schemaError = "顶层必须是 JSON 对象";
      } else parsedSchema = v as Record<string, unknown>;
    } catch (e) {
      schemaError = e instanceof Error ? e.message : "JSON 解析失败";
    }
  }

  // inputSchema 同样即时反馈 —— 它是【入站】契约,写错了第三方系统会被莫名其妙地 400
  const inputText = draft.inputSchemaText.trim();
  let inputSchemaError: string | null = null;
  let parsedInputSchema: Record<string, unknown> | undefined;
  if (inputText) {
    try {
      const v = JSON.parse(inputText);
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        inputSchemaError = "顶层必须是 JSON 对象";
      } else parsedInputSchema = v as Record<string, unknown>;
    } catch (e) {
      inputSchemaError = e instanceof Error ? e.message : "JSON 解析失败";
    }
  }

  const canSave =
    draft.name.trim() && draft.systemPrompt.trim() && !schemaError && !inputSchemaError && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/assistants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draft.id.trim() || undefined,
          name: draft.name.trim(),
          description: draft.description.trim() || undefined,
          webhookUrl: draft.webhookUrl.trim() || undefined,
          config: {
            systemPrompt: draft.systemPrompt,
            model: draft.model,
            maxTurns: Number(draft.maxTurns) || 20,
            inputSchema: parsedInputSchema,
            outputSchema: parsedSchema,
            // 留空 = 不限制。给空数组的语义是「一个工具都不许用」,两者不能混
            tools: parseSkills(draft.toolsText).map((name) => ({ name })),
            skills: parseSkills(draft.skillsText),
            permissionMode: draft.permissionMode,
            approvalRules:
              draft.approvalToolsText.trim() || draft.approvalPatternsText.trim()
                ? {
                    tools: parseSkills(draft.approvalToolsText),
                    commandPatterns: draft.approvalPatternsText
                      .split(/[,，\n]+/)
                      .map((x) => x.trim())
                      .filter(Boolean),
                  }
                : undefined,
            mcpServers: draft.mcpServers
              .filter((m) => m.name.trim())
              .map((m) => ({
                name: m.name.trim(),
                type: m.type,
                url: m.type === "http" ? m.url.trim() : undefined,
              })),
            // 名字与提示词都填了才算数 —— 半截的子代理存进去只会在运行时报错
            subagents: draft.subagents
              .filter((s) => s.name.trim() && s.prompt.trim())
              .map((s) => ({
                name: s.name.trim(),
                description: s.description.trim() || undefined,
                prompt: s.prompt.trim(),
                background: false,
              })),
          },
        }),
      });
      const data = (await res.json()) as { assistant?: AssistantSummary; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMsg(`已保存:${data.assistant?.id}`);
      await reload();
    } catch (e) {
      setMsg(`保存失败:${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  function edit(a: AssistantSummary) {
    void fetch("/api/assistants")
      .then((r) => r.json())
      .then((d: { assistants?: (AssistantSummary & { config: Record<string, unknown> })[] }) => {
        const full = d.assistants?.find((x) => x.id === a.id);
        if (!full) return;
        const cfg = full.config as Record<string, unknown>;
        setDraft({
          id: full.id,
          name: full.name,
          description: full.description ?? "",
          systemPrompt: String(cfg.systemPrompt ?? ""),
          model: String(cfg.model ?? "sonnet"),
          maxTurns: Number(cfg.maxTurns ?? 20),
          inputSchemaText: cfg.inputSchema ? JSON.stringify(cfg.inputSchema, null, 2) : "",
          outputSchemaText: cfg.outputSchema ? JSON.stringify(cfg.outputSchema, null, 2) : "",
          toolsText: Array.isArray(cfg.tools)
            ? (cfg.tools as { name?: string }[])
                .map((t) => t.name ?? "")
                .filter(Boolean)
                .join(", ")
            : "",
          webhookUrl: (full as { webhookUrl?: string }).webhookUrl ?? "",
          skillsText: Array.isArray(cfg.skills) ? (cfg.skills as string[]).join(", ") : "",
          approvalToolsText: Array.isArray(
            (cfg.approvalRules as { tools?: string[] } | undefined)?.tools,
          )
            ? ((cfg.approvalRules as { tools: string[] }).tools ?? []).join(", ")
            : "",
          approvalPatternsText: Array.isArray(
            (cfg.approvalRules as { commandPatterns?: string[] } | undefined)?.commandPatterns,
          )
            ? ((cfg.approvalRules as { commandPatterns: string[] }).commandPatterns ?? []).join(
                ", ",
              )
            : "",
          // 存的是历史值时可能是个已废弃/写错的模式,回落到 default 而不是把界面搞崩
          permissionMode: PERMISSION_MODES.includes(cfg.permissionMode as PermissionMode)
            ? (cfg.permissionMode as PermissionMode)
            : "default",
          mcpServers: Array.isArray(cfg.mcpServers)
            ? (cfg.mcpServers as McpDraft[]).map((m) => ({
                uid: crypto.randomUUID(),
                name: m.name ?? "",
                type: m.type === "stdio" ? ("stdio" as const) : ("http" as const),
                url: m.url ?? "",
              }))
            : [],
          subagents: Array.isArray(cfg.subagents)
            ? (cfg.subagents as { name?: string; description?: string; prompt?: string }[]).map(
                (s) => ({
                  uid: crypto.randomUUID(),
                  name: s.name ?? "",
                  description: s.description ?? "",
                  prompt: s.prompt ?? "",
                }),
              )
            : [],
        });
        setMsg(null);
      });
  }

  const field =
    "w-full rounded border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50";

  return (
    <div className="mx-auto flex h-screen max-w-6xl gap-6 p-6">
      <aside className="w-56 shrink-0 space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">助手</h2>
          <Link href="/" className="text-xs underline opacity-60 hover:opacity-100">
            工作台
          </Link>
        </div>
        <button
          type="button"
          className="w-full rounded bg-black/5 py-1 text-xs hover:bg-black/10 dark:bg-white/10"
          onClick={() => setDraft(EMPTY)}
        >
          + 新建助手
        </button>
        {list.map((a) => (
          <button
            key={a.id}
            type="button"
            className="block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => edit(a)}
          >
            {a.name}
            {a.config.outputSchema && <span className="ml-1 opacity-50">·接口型</span>}
            {(a as { isPublic?: boolean }).isPublic && (
              <span className="ml-1 opacity-50">·公开</span>
            )}
            {(a as { canWrite?: boolean }).canWrite === false && (
              <span className="ml-1 opacity-50">·只读</span>
            )}
          </button>
        ))}
      </aside>

      <main className="min-w-0 flex-1 space-y-4 overflow-y-auto">
        <div>
          <h1 className="font-semibold text-lg">助手构建器</h1>
          <p className="text-xs opacity-55">
            定义一个只干特定某件事的"员工"。填了 outputSchema,它就能被企业系统当接口调用。
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs opacity-70">名称 *</span>
            <input
              className={field}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="代码评审助手"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs opacity-70">ID(留空自动生成;填已有 ID 即覆盖)</span>
            <input
              className={field}
              value={draft.id}
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
              placeholder="code-reviewer"
            />
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-xs opacity-70">描述</span>
          <input
            className={field}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs opacity-70">系统提示词 *</span>
          <textarea
            className={`${field} h-32 resize-y font-mono`}
            value={draft.systemPrompt}
            onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
            placeholder="你是代码评审专家……"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs opacity-70">模型别名</span>
            <select
              className={field}
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            >
              {["fable", "opus", "sonnet", "haiku"].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs opacity-70">最大轮次</span>
            <input
              type="number"
              className={field}
              value={draft.maxTurns}
              onChange={(e) => setDraft({ ...draft, maxTurns: Number(e.target.value) })}
            />
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-xs opacity-70">
            Skills(逗号或换行分隔,可选)—— SDK 内置技能,如 pdf、xlsx
          </span>
          <input
            className={field}
            value={draft.skillsText}
            onChange={(e) => setDraft({ ...draft, skillsText: e.target.value })}
            placeholder="pdf, xlsx"
          />
        </label>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs opacity-70">MCP 服务(可选)—— 给助手接外部工具</span>
            <button
              type="button"
              className="text-xs underline opacity-60 hover:opacity-100"
              onClick={() =>
                setDraft({
                  ...draft,
                  mcpServers: [...draft.mcpServers, newMcpRow()],
                })
              }
            >
              + 添加
            </button>
          </div>
          {draft.mcpServers.length === 0 && <p className="text-xs opacity-40">未配置 MCP 服务</p>}
          {draft.mcpServers.map((m, i) => (
            <div key={m.uid} className="flex gap-2">
              <input
                className={field}
                value={m.name}
                onChange={(e) => {
                  const next = [...draft.mcpServers];
                  next[i] = { ...m, name: e.target.value };
                  setDraft({ ...draft, mcpServers: next });
                }}
                placeholder="名称(字母/数字/_/-)"
              />
              <select
                className={field}
                value={m.type}
                onChange={(e) => {
                  const next = [...draft.mcpServers];
                  next[i] = { ...m, type: e.target.value as "http" | "stdio" };
                  setDraft({ ...draft, mcpServers: next });
                }}
              >
                <option value="http">http</option>
                <option value="stdio">stdio</option>
              </select>
              <input
                className={field}
                value={m.url}
                disabled={m.type !== "http"}
                onChange={(e) => {
                  const next = [...draft.mcpServers];
                  next[i] = { ...m, url: e.target.value };
                  setDraft({ ...draft, mcpServers: next });
                }}
                placeholder={m.type === "http" ? "https://…" : "(stdio 不需要)"}
              />
              <button
                type="button"
                className="shrink-0 text-red-600 text-xs underline opacity-70 hover:opacity-100"
                onClick={() =>
                  setDraft({ ...draft, mcpServers: draft.mcpServers.filter((_, j) => j !== i) })
                }
              >
                删除
              </button>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs opacity-70">
              子代理(可选)—— 把一类子任务交给带专属提示词的下级去做
            </span>
            <button
              type="button"
              className="text-xs underline opacity-60 hover:opacity-100"
              onClick={() =>
                setDraft({ ...draft, subagents: [...draft.subagents, newSubagentRow()] })
              }
            >
              + 添加
            </button>
          </div>
          {draft.subagents.length === 0 && <p className="text-xs opacity-40">未配置子代理</p>}
          {draft.subagents.map((s, i) => (
            <div key={s.uid} className="flex gap-2">
              <div className="flex-1 space-y-1">
                <div className="flex gap-2">
                  <input
                    className={`${field} max-w-[12rem]`}
                    value={s.name}
                    onChange={(e) => {
                      const next = [...draft.subagents];
                      next[i] = { ...s, name: e.target.value };
                      setDraft({ ...draft, subagents: next });
                    }}
                    placeholder="名称,如 reviewer"
                  />
                  {/* 主 agent 靠这句话决定要不要把子任务交出去 —— 缺了它,
                      子代理配了也没人调用。SDK 侧这是必需字段。 */}
                  <input
                    className={field}
                    value={s.description}
                    onChange={(e) => {
                      const next = [...draft.subagents];
                      next[i] = { ...s, description: e.target.value };
                      setDraft({ ...draft, subagents: next });
                    }}
                    placeholder="【何时】用它,如:需要审阅代码质量时"
                  />
                </div>
                <textarea
                  className={`${field} min-h-[3rem]`}
                  value={s.prompt}
                  onChange={(e) => {
                    const next = [...draft.subagents];
                    next[i] = { ...s, prompt: e.target.value };
                    setDraft({ ...draft, subagents: next });
                  }}
                  placeholder="这个子代理的职责与要求(它的系统提示词)"
                />
              </div>
              <button
                type="button"
                className="shrink-0 text-red-600 text-xs underline opacity-70 hover:opacity-100"
                onClick={() =>
                  setDraft({ ...draft, subagents: draft.subagents.filter((_, j) => j !== i) })
                }
              >
                删除
              </button>
            </div>
          ))}
        </div>

        <label className="block space-y-1">
          <span className="text-xs opacity-70">权限模式 —— 按【使用场景】选,不是安全等级</span>
          <select
            className={field}
            value={draft.permissionMode}
            onChange={(e) =>
              setDraft({ ...draft, permissionMode: e.target.value as PermissionMode })
            }
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {PERMISSION_MODE_META[m].label}
              </option>
            ))}
          </select>
          <span className="block text-xs opacity-45">
            {PERMISSION_MODE_META[draft.permissionMode].hint}
            {draft.permissionMode === "bypassPermissions" &&
              " 子代理会一并继承该模式,无法单独收紧。"}
          </span>
        </label>

        {/* 无人值守却配了审批 = 这一轮会一直挂到审批超时。放在这里提醒,
            因为两个设置离得远时没人会把它们联系起来。 */}
        {draft.permissionMode === "bypassPermissions" &&
          (draft.approvalToolsText.trim() || draft.approvalPatternsText.trim()) && (
            <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs">
              这个模式通常用于无人值守的接口调用,而你配了审批规则 ——
              没人去点确认的话,那一轮会一直挂到审批超时。
            </p>
          )}

        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs opacity-70">需审批的工具(逗号分隔,可选)</span>
            <input
              className={field}
              value={draft.approvalToolsText}
              onChange={(e) => setDraft({ ...draft, approvalToolsText: e.target.value })}
              placeholder="Bash, Write"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs opacity-70">需审批的命令模式(逗号分隔)</span>
            <input
              className={field}
              value={draft.approvalPatternsText}
              onChange={(e) => setDraft({ ...draft, approvalPatternsText: e.target.value })}
              placeholder="rm -rf, sudo, curl"
            />
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-xs opacity-70">Webhook 回调(可选)—— 运行终态时推结果</span>
          <input
            className={field}
            value={draft.webhookUrl}
            onChange={(e) => setDraft({ ...draft, webhookUrl: e.target.value })}
            placeholder="https://your-system/callback"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs opacity-70">
            工具白名单(逗号分隔,可选)—— 留空 = 不限制;填了就只允许这些工具
          </span>
          <input
            className={field}
            value={draft.toolsText}
            onChange={(e) => setDraft({ ...draft, toolsText: e.target.value })}
            placeholder="Read, Write, Bash"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs opacity-70">
            inputSchema(JSON Schema,可选)—— 填了则 invoke 的入参必须符合它,否则 400
          </span>
          <textarea
            className={`${field} h-40 resize-y font-mono text-xs`}
            value={draft.inputSchemaText}
            onChange={(e) => setDraft({ ...draft, inputSchemaText: e.target.value })}
            placeholder={INPUT_SCHEMA_EXAMPLE}
          />
          {inputSchemaError && (
            <span className="text-red-600 text-xs">inputSchema 非法:{inputSchemaError}</span>
          )}
        </label>

        <label className="block space-y-1">
          <span className="text-xs opacity-70">
            outputSchema(JSON Schema,可选)—— 填了才能被系统当接口调用
          </span>
          <textarea
            className={`${field} h-56 resize-y font-mono text-xs`}
            value={draft.outputSchemaText}
            onChange={(e) => setDraft({ ...draft, outputSchemaText: e.target.value })}
            placeholder={SCHEMA_EXAMPLE}
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-white dark:text-black"
            onClick={save}
            disabled={!canSave}
          >
            {saving ? "保存中…" : "保存助手"}
          </button>
          <button
            type="button"
            className="text-xs underline opacity-60 hover:opacity-100"
            onClick={() => setDraft({ ...draft, outputSchemaText: SCHEMA_EXAMPLE })}
          >
            填入示例 schema
          </button>
          {schemaError && <span className="text-red-600 text-xs">schema 非法:{schemaError}</span>}
          {!schemaError && schemaText && (
            <span className="text-green-600 text-xs">schema 合法 · 接口型助手</span>
          )}
          {msg && <span className="text-xs opacity-70">{msg}</span>}
        </div>

        {draft.id && (
          <KnowledgePanel
            assistantId={draft.id}
            canWrite={list.find((a) => a.id === draft.id)?.canWrite !== false}
          />
        )}

        {draft.id && <SharePanel assistantId={draft.id} />}

        {draft.id && parsedSchema && (
          <div className="rounded border border-black/10 p-3 text-xs dark:border-white/15">
            <p className="mb-1 font-medium">第三方系统这样调用它:</p>
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono opacity-70">
              {`curl -X POST /api/agents/${draft.id}/invoke \\
  -H 'Content-Type: application/json' \\
  -d '{"input":"……"}'
# → { "taskId": "…" }
curl /api/agents/{taskId}/result
# → { "status":"success", "structured": { … } }`}
            </pre>
          </div>
        )}
      </main>
    </div>
  );
}
