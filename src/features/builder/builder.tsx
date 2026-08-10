"use client";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect as Select } from "@/components/ui/native-select";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Textarea } from "@/components/ui/textarea";
import { KnowledgePanel } from "@/features/builder/knowledge-panel";
import { SharePanel } from "@/features/builder/share-panel";
import type { AssistantSummary } from "@/features/workbench/types";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { PERMISSION_MODES, type PermissionMode } from "@/lib/shared";
import { cn } from "@/lib/utils";
import { Bot, FileCode, Plus, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

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
  command: string;
  /** 每行一个参数,避免用空格拆分时破坏带空格的单个参数。 */
  argsText: string;
  /** JSON 字符串对象。env 常含 URL、token 等不能可靠按分隔符拆。 */
  envText: string;
}

function newMcpRow(): McpDraft {
  return {
    uid: crypto.randomUUID(),
    name: "",
    type: "http",
    url: "",
    command: "",
    argsText: "",
    envText: "",
  };
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

type BuilderAssistant = AssistantSummary & { config: Record<string, unknown> };

interface AssistantsResponse {
  assistants?: BuilderAssistant[];
  capabilities?: { stdioMcp?: boolean };
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
  const [allowStdioMcp, setAllowStdioMcp] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(
    () =>
      fetchJson<AssistantsResponse>("/api/assistants")
        .then((d) => {
          setList(d.assistants ?? []);
          setAllowStdioMcp(d.capabilities?.stdioMcp === true);
        })
        .catch((e: unknown) => toast.error(`助手列表加载失败:${errorText(e)}`)),
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
    try {
      const mcpServers = draft.mcpServers
        .filter((m) => m.name.trim())
        .map((m) => {
          if (m.type === "http") {
            return { name: m.name.trim(), type: "http" as const, url: m.url.trim() };
          }

          let env: Record<string, string> | undefined;
          if (m.envText.trim()) {
            const parsed = JSON.parse(m.envText) as unknown;
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              Array.isArray(parsed) ||
              Object.values(parsed).some((v) => typeof v !== "string")
            ) {
              throw new Error(`MCP「${m.name || "未命名"}」的 env 必须是字符串键值 JSON 对象`);
            }
            env = parsed as Record<string, string>;
          }

          return {
            name: m.name.trim(),
            type: "stdio" as const,
            command: m.command.trim(),
            args: m.argsText
              .split("\n")
              .map((x) => x.trim())
              .filter(Boolean),
            env,
          };
        });

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
            mcpServers,
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
      toast.success(`已保存:${data.assistant?.id}`);
      await reload();
    } catch (e) {
      toast.error(`保存失败:${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  function edit(a: AssistantSummary) {
    void fetchJson<AssistantsResponse>("/api/assistants")
      .then((d) => {
        setAllowStdioMcp(d.capabilities?.stdioMcp === true);
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
            ? (
                cfg.mcpServers as {
                  name?: string;
                  type?: string;
                  url?: string;
                  command?: string;
                  args?: unknown;
                  env?: unknown;
                }[]
              ).map((m) => ({
                uid: crypto.randomUUID(),
                name: m.name ?? "",
                type: m.type === "stdio" ? ("stdio" as const) : ("http" as const),
                url: m.url ?? "",
                command: m.command ?? "",
                argsText: Array.isArray(m.args) ? m.args.join("\n") : "",
                envText:
                  m.env && typeof m.env === "object" && !Array.isArray(m.env)
                    ? JSON.stringify(m.env, null, 2)
                    : "",
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
      })
      // 点了助手却没反应最让人困惑 —— 至少说清楚是没读到,而不是这个助手本身是空的
      .catch((e: unknown) => toast.error(`打开助手失败:${errorText(e)}`));
  }

  /** 助手列表挂进全站侧栏 —— 再开一条自己的侧栏就成了两级导航,看着像两个产品 */
  const assistantList = (
    <SidebarGroup>
      <SidebarGroupLabel>助手</SidebarGroupLabel>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={() => setDraft(EMPTY)} tooltip="新建助手">
            <Plus className="text-muted-foreground/60" />
            <span className="text-xs">新建助手</span>
          </SidebarMenuButton>
        </SidebarMenuItem>

        {list.map((a) => {
          const active = draft.id === a.id;
          return (
            <SidebarMenuItem key={a.id}>
              <SidebarMenuButton
                isActive={active}
                tooltip={a.name}
                onClick={() => edit(a)}
                className="relative data-[active=true]:bg-sidebar-active data-[active=true]:text-sidebar-active-foreground"
              >
                <span
                  className={cn(
                    "absolute left-0 top-1.5 bottom-1.5 w-0.5 origin-left rounded-r-full bg-brand transition-transform duration-200",
                    active ? "scale-x-100" : "scale-x-0",
                  )}
                />
                <Bot className={cn(active ? "text-brand" : "text-muted-foreground/60")} />
                <span className="min-w-0 flex-1 truncate text-xs">{a.name}</span>
                {a.config.outputSchema && (
                  <Badge variant="secondary" className="shrink-0 px-1 text-[9px]">
                    接口
                  </Badge>
                )}
                {(a as { canWrite?: boolean }).canWrite === false && (
                  <Badge variant="outline" className="shrink-0 px-1 text-[9px]">
                    只读
                  </Badge>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );

  return (
    <AppShell
      title="助手构建器"
      subtitle={'定义一个只干特定某件事的"员工"。填了 outputSchema,它就能被企业系统当接口调用。'}
      sidebarExtra={assistantList}
      actions={
        <Button size="sm" onClick={save} disabled={!canSave}>
          <Save className="size-3.5" />
          {saving ? "保存中…" : "保存助手"}
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">名称 *</span>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="代码评审助手"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">ID(留空自动生成;填已有 ID 即覆盖)</span>
          <Input
            value={draft.id}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            placeholder="code-reviewer"
          />
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">描述</span>
        <Input
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">系统提示词 *</span>
        <Textarea
          className="h-32 resize-y font-mono"
          value={draft.systemPrompt}
          onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
          placeholder="你是代码评审专家……"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">模型别名</span>
          <Select
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          >
            {["fable", "opus", "sonnet", "haiku"].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">最大轮次</span>
          <Input
            type="number"
            value={draft.maxTurns}
            onChange={(e) => setDraft({ ...draft, maxTurns: Number(e.target.value) })}
          />
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">
          Skills(逗号或换行分隔,可选)—— SDK 内置技能,如 pdf、xlsx
        </span>
        <Input
          value={draft.skillsText}
          onChange={(e) => setDraft({ ...draft, skillsText: e.target.value })}
          placeholder="pdf, xlsx"
        />
      </label>

      {/* ── MCP 服务 ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">MCP 服务</CardTitle>
              <CardDescription>给助手接外部工具(可选)</CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setDraft({
                  ...draft,
                  mcpServers: [...draft.mcpServers, newMcpRow()],
                })
              }
            >
              <Plus /> 添加
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {draft.mcpServers.length === 0 && (
            <p className="text-xs text-muted-foreground">未配置 MCP 服务</p>
          )}
          {draft.mcpServers.map((m, i) => (
            <div key={m.uid} className="space-y-2 border-b border-border pb-3 last:border-b-0">
              <div className="flex gap-2">
                <Input
                  value={m.name}
                  onChange={(e) => {
                    const next = [...draft.mcpServers];
                    next[i] = { ...m, name: e.target.value };
                    setDraft({ ...draft, mcpServers: next });
                  }}
                  placeholder="名称(字母/数字/_/-)"
                />
                <Select
                  value={m.type}
                  onChange={(e) => {
                    const next = [...draft.mcpServers];
                    next[i] = { ...m, type: e.target.value as "http" | "stdio" };
                    setDraft({ ...draft, mcpServers: next });
                  }}
                >
                  <option value="http">http</option>
                  <option value="stdio" disabled={!allowStdioMcp}>
                    {allowStdioMcp ? "stdio" : "stdio（平台未启用）"}
                  </option>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-destructive hover:text-destructive"
                  onClick={() =>
                    setDraft({ ...draft, mcpServers: draft.mcpServers.filter((_, j) => j !== i) })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
              {m.type === "http" ? (
                <Input
                  value={m.url}
                  onChange={(e) => {
                    const next = [...draft.mcpServers];
                    next[i] = { ...m, url: e.target.value };
                    setDraft({ ...draft, mcpServers: next });
                  }}
                  placeholder="https://mcp.example.com"
                />
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    className="col-span-2"
                    value={m.command}
                    onChange={(e) => {
                      const next = [...draft.mcpServers];
                      next[i] = { ...m, command: e.target.value };
                      setDraft({ ...draft, mcpServers: next });
                    }}
                    placeholder="command，例如 npx"
                  />
                  <Textarea
                    className="min-h-24 resize-y font-mono"
                    value={m.argsText}
                    onChange={(e) => {
                      const next = [...draft.mcpServers];
                      next[i] = { ...m, argsText: e.target.value };
                      setDraft({ ...draft, mcpServers: next });
                    }}
                    placeholder={"args，每行一个\n-y\n@modelcontextprotocol/server-filesystem"}
                  />
                  <Textarea
                    className="min-h-24 resize-y font-mono"
                    value={m.envText}
                    onChange={(e) => {
                      const next = [...draft.mcpServers];
                      next[i] = { ...m, envText: e.target.value };
                      setDraft({ ...draft, mcpServers: next });
                    }}
                    placeholder={'env JSON，例如\n{"GITHUB_TOKEN":"..."}'}
                  />
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ── 子代理 ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">子代理</CardTitle>
              <CardDescription>把一类子任务交给带专属提示词的下级去做(可选)</CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setDraft({ ...draft, subagents: [...draft.subagents, newSubagentRow()] })
              }
            >
              <Plus /> 添加
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {draft.subagents.length === 0 && (
            <p className="text-xs text-muted-foreground">未配置子代理</p>
          )}
          {draft.subagents.map((s, i) => (
            <div key={s.uid} className="flex gap-2">
              <div className="flex-1 space-y-1">
                <div className="flex gap-2">
                  <Input
                    className="max-w-[12rem]"
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
                  <Input
                    value={s.description}
                    onChange={(e) => {
                      const next = [...draft.subagents];
                      next[i] = { ...s, description: e.target.value };
                      setDraft({ ...draft, subagents: next });
                    }}
                    placeholder="【何时】用它,如:需要审阅代码质量时"
                  />
                </div>
                <Textarea
                  className="min-h-[3rem]"
                  value={s.prompt}
                  onChange={(e) => {
                    const next = [...draft.subagents];
                    next[i] = { ...s, prompt: e.target.value };
                    setDraft({ ...draft, subagents: next });
                  }}
                  placeholder="这个子代理的职责与要求(它的系统提示词)"
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 text-destructive hover:text-destructive"
                onClick={() =>
                  setDraft({ ...draft, subagents: draft.subagents.filter((_, j) => j !== i) })
                }
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">
          权限模式 —— 按【使用场景】选,不是安全等级
        </span>
        <Select
          value={draft.permissionMode}
          onChange={(e) => setDraft({ ...draft, permissionMode: e.target.value as PermissionMode })}
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m} value={m}>
              {PERMISSION_MODE_META[m].label}
            </option>
          ))}
        </Select>
        <span className="block text-xs text-muted-foreground">
          {PERMISSION_MODE_META[draft.permissionMode].hint}
          {draft.permissionMode === "bypassPermissions" && " 子代理会一并继承该模式,无法单独收紧。"}
        </span>
      </label>

      {/* 无人值守却配了审批 = 这一轮会一直挂到审批超时。放在这里提醒,
            因为两个设置离得远时没人会把它们联系起来。 */}
      {draft.permissionMode === "bypassPermissions" &&
        (draft.approvalToolsText.trim() || draft.approvalPatternsText.trim()) && (
          <p className="rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-2 py-1.5 text-xs">
            这个模式通常用于无人值守的接口调用,而你配了审批规则 ——
            没人去点确认的话,那一轮会一直挂到审批超时。
          </p>
        )}

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">需审批的工具(逗号分隔,可选)</span>
          <Input
            value={draft.approvalToolsText}
            onChange={(e) => setDraft({ ...draft, approvalToolsText: e.target.value })}
            placeholder="Bash, Write"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">需审批的命令模式(逗号分隔)</span>
          <Input
            value={draft.approvalPatternsText}
            onChange={(e) => setDraft({ ...draft, approvalPatternsText: e.target.value })}
            placeholder="rm -rf, sudo, curl"
          />
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">Webhook 回调(可选)—— 运行终态时推结果</span>
        <Input
          value={draft.webhookUrl}
          onChange={(e) => setDraft({ ...draft, webhookUrl: e.target.value })}
          placeholder="https://your-system/callback"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">
          工具白名单(逗号分隔,可选)—— 留空 = 不限制;填了就只允许这些工具
        </span>
        <Input
          value={draft.toolsText}
          onChange={(e) => setDraft({ ...draft, toolsText: e.target.value })}
          placeholder="Read, Write, Bash"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">
          inputSchema(JSON Schema,可选)—— 填了则 invoke 的入参必须符合它,否则 400
        </span>
        <Textarea
          className="h-40 resize-y font-mono text-xs"
          value={draft.inputSchemaText}
          onChange={(e) => setDraft({ ...draft, inputSchemaText: e.target.value })}
          placeholder={INPUT_SCHEMA_EXAMPLE}
        />
        {inputSchemaError && (
          <span className="text-xs text-destructive">inputSchema 非法:{inputSchemaError}</span>
        )}
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">
          outputSchema(JSON Schema,可选)—— 填了才能被系统当接口调用
        </span>
        <Textarea
          className="h-56 resize-y font-mono text-xs"
          value={draft.outputSchemaText}
          onChange={(e) => setDraft({ ...draft, outputSchemaText: e.target.value })}
          placeholder={SCHEMA_EXAMPLE}
        />
      </label>

      {/* 保存按钮已提到吸顶页头 —— 这是个八百行的长表单,不该滚到底才能存 */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDraft({ ...draft, outputSchemaText: SCHEMA_EXAMPLE })}
        >
          <FileCode /> 填入示例 schema
        </Button>
        {schemaError && <span className="text-xs text-destructive">schema 非法:{schemaError}</span>}
        {!schemaError && schemaText && <Badge variant="success">schema 合法 · 接口型助手</Badge>}
      </div>

      {draft.id && (
        <KnowledgePanel
          assistantId={draft.id}
          canWrite={list.find((a) => a.id === draft.id)?.canWrite !== false}
        />
      )}

      {draft.id && <SharePanel assistantId={draft.id} />}

      {draft.id && parsedSchema && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">第三方系统这样调用它:</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
              {`curl -X POST /api/agents/${draft.id}/invoke \\
  -H 'Content-Type: application/json' \\
  -d '{"input":"……"}'
# → { "taskId": "…" }
curl /api/agents/{taskId}/result
# → { "status":"success", "structured": { … } }`}
            </pre>
          </CardContent>
        </Card>
      )}
    </AppShell>
  );
}
