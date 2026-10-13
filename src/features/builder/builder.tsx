"use client";

import { SpaceShell } from "@/components/space-shell";
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
import type { AgentSummary } from "@/features/workbench/types";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { PERMISSION_MODES, type PermissionMode } from "@/lib/shared";
import { cn } from "@/lib/utils";
import { Bot, FileCode, Play, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/** 子代理:让智能体把一类子任务交给一个带专属提示词的下级去做。 */
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

/**
 * 技能包:SKILL.md 之外的附带文件(脚本、模板)在这里原样保留、不提供编辑 ——
 * 多文件的技能请用"AI 设计"修改。曾经构建器不认识技能包,保存一次就把它们全清掉了。
 */
interface SkillDraft {
  uid: string;
  name: string;
  description: string;
  body: string;
  extraFiles: Record<string, string>;
}

function newSkillRow(): SkillDraft {
  return { uid: crypto.randomUUID(), name: "", description: "", body: "", extraFiles: {} };
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
  skillPackages: SkillDraft[];
  mcpServers: McpDraft[];
  subagents: SubagentDraft[];
  /** 需审批的工具名(逗号分隔) */
  approvalToolsText: string;
  /** 需审批的命令模式(逗号分隔) */
  approvalPatternsText: string;
  /** 权限模式;按场景选,不是安全等级 */
  permissionMode: PermissionMode;
  /** 没有审批人时(接口调用、嵌入组件)命中审批规则怎么办;空 = 按入口默认 */
  unattendedApproval: "" | "allow" | "deny";
  /** 开场建议,一行一条 */
  startersText: string;
}

type BuilderAgent = AgentSummary & { config: Record<string, unknown> };

interface AgentsResponse {
  agents?: BuilderAgent[];
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
  skillPackages: [],
  mcpServers: [],
  subagents: [],
  approvalToolsText: "",
  approvalPatternsText: "",
  permissionMode: "default",
  unattendedApproval: "",
  startersText: "",
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
/**
 * 以已加载的配置为底,覆盖表单管理的字段。表单字段值为 undefined 表示"清空",要真的删掉 ——
 * 直接展开的话 JSON 会丢掉 undefined 键,底下的旧值就又冒出来了。
 */
export function overlayConfig(
  base: Record<string, unknown>,
  form: Record<string, unknown>,
): Record<string, unknown> {
  const cleared = new Set(Object.keys(form).filter((k) => form[k] === undefined));
  // 旧版"技能名"字段从未生效;表单已改用技能包,不再回写它
  cleared.add("skills");
  return Object.fromEntries(Object.entries({ ...base, ...form }).filter(([k]) => !cleared.has(k)));
}

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
  const [list, setList] = useState<AgentSummary[]>([]);
  const [allowStdioMcp, setAllowStdioMcp] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  /**
   * 当前打开的是哪个已保存的智能体;null = 正在新建。
   *
   * 【为什么不能用 draft.id 推断】曾经 selectedAgent = list.find(a => a.id === draft.id):
   * 新建时在 ID 框里敲出某个已有 ID 的瞬间,输入框被禁用、整页可能切到别人的只读视图,
   * 知识库/分享面板还会按每次按键对那个智能体发请求 —— 保存之前就能往别人的知识库里加文档。
   */
  const [openedId, setOpenedId] = useState<string | null>(null);
  /**
   * 打开的智能体的完整配置。保存时以它为底、只覆盖表单管理的字段 ——
   * 表单不认识的字段(effort、设计师写入的新字段……)原样保留,而不是被一次保存清掉。
   */
  const loadedConfigRef = useRef<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const cleanDraftRef = useRef(JSON.stringify(EMPTY));
  const editSeqRef = useRef(0);
  const allowNavigationRef = useRef(false);
  const dirty = useMemo(() => JSON.stringify(draft) !== cleanDraftRef.current, [draft]);

  const setCleanDraft = useCallback((next: Draft) => {
    cleanDraftRef.current = JSON.stringify(next);
    setDraft(next);
  }, []);

  const confirmDiscard = useCallback(
    () => !dirty || window.confirm("当前智能体有未保存修改，确定放弃这些修改？"),
    [dirty],
  );

  const reload = useCallback(
    () =>
      fetchJson<AgentsResponse>("/api/agents")
        .then((d) => {
          setList(d.agents ?? []);
          setAllowStdioMcp(d.capabilities?.stdioMcp === true);
        })
        .catch((e: unknown) => toast.error(`智能体列表加载失败:${errorText(e)}`)),
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowNavigationRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const guardInternalLink = (event: MouseEvent) => {
      if (allowNavigationRef.current || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank") return;
      if (!window.confirm("当前智能体有未保存修改，确定离开并放弃这些修改？")) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      allowNavigationRef.current = true;
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    document.addEventListener("click", guardInternalLink, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      document.removeEventListener("click", guardInternalLink, true);
    };
  }, [dirty]);

  // outputSchema 的合法性即时反馈 —— 它是对外接口契约,写错了整个智能体就不可用
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

  const selectedAgent = openedId ? list.find((agent) => agent.id === openedId) : undefined;
  const canWrite = selectedAgent?.canWrite !== false;
  // 新建时自己就是所有者;已有的看服务端给的判定
  const canManageWebhook = selectedAgent?.canManageWebhook !== false;
  const canSave =
    canWrite &&
    dirty &&
    draft.name.trim() &&
    draft.systemPrompt.trim() &&
    !schemaError &&
    !inputSchemaError &&
    !saving;

  const router = useRouter();
  const [designing, setDesigning] = useState(false);

  /**
   * 开一个"AI 智能体设计师"会话并跳到工作台。
   * 修改已有智能体时,它当前的定义会先导出到设计会话的工作目录里。
   */
  async function startDesign(agentId?: string) {
    if (dirty && !window.confirm("当前有未保存的修改,设计会话看不到它们。仍然继续?")) return;
    setDesigning(true);
    try {
      const d = await fetchJson<{ sessionId: string }>("/api/agents/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(agentId ? { agentId } : {}),
      });
      allowNavigationRef.current = true;
      router.push(`/?session=${encodeURIComponent(d.sessionId)}`);
    } catch (e) {
      toast.error(`无法开始设计:${errorText(e)}`);
      setDesigning(false);
    }
  }

  async function save() {
    if (!canSave) return;
    // 新建时撞上已有 ID 会覆盖那个智能体 —— 明确拦下,而不是悄悄改掉别的配置
    const wantedId = draft.id.trim();
    if (!openedId && wantedId && list.some((a) => a.id === wantedId)) {
      toast.error(`ID「${wantedId}」已被占用,请换一个,或从左侧打开该智能体编辑`);
      return;
    }
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

      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draft.id.trim() || undefined,
          name: draft.name.trim(),
          description: draft.description.trim() || undefined,
          webhookUrl: draft.webhookUrl.trim() || undefined,
          config: overlayConfig(loadedConfigRef.current, {
            systemPrompt: draft.systemPrompt,
            model: draft.model,
            maxTurns: Number(draft.maxTurns) || 20,
            inputSchema: parsedInputSchema,
            outputSchema: parsedSchema,
            // 留空 = 不限制。给空数组的语义是「一个工具都不许用」,两者不能混
            tools: parseSkills(draft.toolsText).map((name) => ({ name })),
            skillPackages: draft.skillPackages
              .filter((k) => k.name.trim())
              .map((k) => ({
                name: k.name.trim(),
                description: k.description.trim(),
                files: { ...k.extraFiles, "SKILL.md": k.body },
              })),
            permissionMode: draft.permissionMode,
            unattendedApproval: draft.unattendedApproval || undefined,
            starters: (() => {
              const lines = draft.startersText
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean);
              return lines.length ? lines.slice(0, 4) : undefined;
            })(),
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
          }),
        }),
      });
      const data = (await res.json()) as { agent?: AgentSummary; error?: string };
      if (!res.ok || data.error || !data.agent) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const savedDraft = { ...draft, id: data.agent.id };
      cleanDraftRef.current = JSON.stringify(savedDraft);
      setDraft((current) => ({ ...current, id: data.agent?.id ?? current.id }));
      setOpenedId(data.agent.id);
      toast.success(`已保存:${data.agent.id}`);
      await reload();
    } catch (e) {
      toast.error(`保存失败:${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  function edit(a: AgentSummary) {
    if (a.id !== openedId && !confirmDiscard()) return;
    const seq = ++editSeqRef.current;
    void fetchJson<AgentsResponse>("/api/agents")
      .then((d) => {
        if (seq !== editSeqRef.current) return;
        setAllowStdioMcp(d.capabilities?.stdioMcp === true);
        const full = d.agents?.find((x) => x.id === a.id);
        if (!full) return;
        const cfg = full.config as Record<string, unknown>;
        loadedConfigRef.current = cfg;
        const nextDraft: Draft = {
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
          skillPackages: Array.isArray(cfg.skillPackages)
            ? (
                cfg.skillPackages as {
                  name: string;
                  description: string;
                  files: Record<string, string>;
                }[]
              ).map((k) => {
                const { "SKILL.md": body = "", ...extraFiles } = k.files ?? {};
                return {
                  uid: crypto.randomUUID(),
                  name: k.name,
                  description: k.description,
                  body,
                  extraFiles,
                };
              })
            : [],
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
          unattendedApproval:
            cfg.unattendedApproval === "allow" || cfg.unattendedApproval === "deny"
              ? cfg.unattendedApproval
              : "",
          startersText: Array.isArray(cfg.starters) ? (cfg.starters as string[]).join("\n") : "",
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
        };
        setCleanDraft(nextDraft);
        setOpenedId(a.id);
      })
      // 点了智能体却没反应最让人困惑 —— 至少说清楚是没读到,而不是这个智能体本身是空的
      .catch((error: unknown) => {
        if (seq === editSeqRef.current) toast.error(`打开智能体失败:${errorText(error)}`);
      });
  }

  /** 智能体列表挂进子空间侧栏 —— 再开一条自己的侧栏就成了两级导航,看着像两个产品 */
  const agentList = (
    <SidebarGroup>
      {/*
        标签写数量而不是"智能体"。
        【为什么】侧栏顶部的空间标识已经写着「我的智能体」,紧跟一个同名标签
        等于把同一句话说两遍;数量是这个位置唯一还能提供新信息的东西。
      */}
      <SidebarGroupLabel>共 {list.length} 个</SidebarGroupLabel>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={() => {
              if (!confirmDiscard()) return;
              editSeqRef.current += 1;
              setCleanDraft(EMPTY);
              setOpenedId(null);
              loadedConfigRef.current = {};
            }}
            tooltip="新建智能体"
          >
            <Plus className="text-muted-foreground/60" />
            <span className="text-xs">新建智能体</span>
          </SidebarMenuButton>
        </SidebarMenuItem>

        {list.map((a) => {
          const active = openedId === a.id;
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

  if (selectedAgent && !canWrite) {
    return (
      <SpaceShell
        area="agents"
        title={selectedAgent.name}
        subtitle="只读智能体配置"
        sidebarExtra={agentList}
      >
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          这是只读智能体。配置仅供查看，需要修改时请联系所有者。
        </p>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">配置</CardTitle>
            {selectedAgent.description && (
              <CardDescription>{selectedAgent.description}</CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
              {JSON.stringify((selectedAgent as BuilderAgent).config, null, 2)}
            </pre>
          </CardContent>
        </Card>
        <KnowledgePanel agentId={selectedAgent.id} canWrite={false} />
      </SpaceShell>
    );
  }

  return (
    <SpaceShell
      area="agents"
      title="我的智能体"
      subtitle={'定义一个只干特定某件事的"员工"。填了 outputSchema,它就能被企业系统当接口调用。'}
      sidebarExtra={agentList}
      actions={
        <>
          {openedId && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open(`/?agent=${encodeURIComponent(openedId)}`, "_blank")}
            >
              <Play className="size-3.5" />
              试运行
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={designing || (Boolean(openedId) && !canWrite)}
            onClick={() => void startDesign(openedId ?? undefined)}
            title="和 AI 对话来设计:提示词、技能、MCP、输入输出契约"
          >
            <Sparkles className="size-3.5" />
            {designing ? "准备中…" : openedId ? "用 AI 修改" : "用 AI 设计"}
          </Button>
          <Button size="sm" onClick={save} disabled={!canSave}>
            <Save className="size-3.5" />
            {saving ? "保存中…" : "保存智能体"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">名称 *</span>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="代码评审智能体"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">ID(留空自动生成;保存后不可修改)</span>
          <Input
            value={draft.id}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            placeholder="code-reviewer"
            disabled={Boolean(openedId)}
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
        <span className="text-xs text-muted-foreground">
          开场建议(可选,一行一条,最多 4 条)—— 工作台新会话里给用户点的示例输入
        </span>
        <Textarea
          className="h-20 resize-y"
          value={draft.startersText}
          onChange={(e) => setDraft({ ...draft, startersText: e.target.value })}
          placeholder={"审一下这份合同的付款条款\n把附件里的发票抽成表格"}
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

      {/* ── 技能包 ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">技能</CardTitle>
              <CardDescription>
                可复用的专门做法:流程、规范、脚本。描述写"何时使用",模型据此自动调用。
                多文件技能(带脚本、模板)建议用「用 AI 修改」编辑。
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setDraft({ ...draft, skillPackages: [...draft.skillPackages, newSkillRow()] })
              }
            >
              <Plus /> 添加
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {draft.skillPackages.length === 0 && (
            <p className="text-xs text-muted-foreground">未配置技能</p>
          )}
          {draft.skillPackages.map((k, i) => {
            const patch = (next: Partial<SkillDraft>) => {
              const list = [...draft.skillPackages];
              list[i] = { ...k, ...next };
              setDraft({ ...draft, skillPackages: list });
            };
            const extra = Object.keys(k.extraFiles).length;
            return (
              <div key={k.uid} className="space-y-2 border-b border-border pb-3 last:border-b-0">
                <div className="flex gap-2">
                  <Input
                    value={k.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="技能名(小写字母、数字、连字符)"
                    aria-label="技能名"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="删除这个技能"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        skillPackages: draft.skillPackages.filter((x) => x.uid !== k.uid),
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
                <Input
                  value={k.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  placeholder="何时使用,如:需要把数学推导做成动画时使用"
                  aria-label="技能描述"
                />
                <Textarea
                  className="h-28 resize-y font-mono"
                  value={k.body}
                  onChange={(e) => patch({ body: e.target.value })}
                  placeholder="SKILL.md 正文:步骤、约定、示例"
                  aria-label="SKILL.md"
                />
                {extra > 0 && (
                  <p className="text-xs text-muted-foreground">
                    另附 {extra} 个文件({Object.keys(k.extraFiles).slice(0, 3).join("、")}
                    {extra > 3 ? "…" : ""}),保存时原样保留
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ── MCP 服务 ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">MCP 服务</CardTitle>
              <CardDescription>给智能体接外部工具(可选)</CardDescription>
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
                  aria-label={`删除 MCP 服务 ${m.name || i + 1}`}
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
                aria-label={`删除子代理 ${s.name || i + 1}`}
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

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">
          没有审批人时(接口调用、嵌入组件)命中下面的审批规则
        </span>
        <Select
          value={draft.unattendedApproval}
          onChange={(e) =>
            setDraft({
              ...draft,
              unattendedApproval: e.target.value as Draft["unattendedApproval"],
            })
          }
        >
          <option value="">按入口默认(接口调用放行,嵌入组件拒绝)</option>
          <option value="deny">一律拒绝(更安全)</option>
          <option value="allow">一律放行</option>
        </Select>
        <span className="block text-xs text-muted-foreground">
          网页工作台里始终等人审批;接口调用与嵌入组件没有审批人,不会挂着等。
        </span>
      </label>

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
        <span className="text-xs text-muted-foreground">
          {canManageWebhook
            ? "Webhook 回调(可选)—— 运行终态时推结果,用你在「模型凭证」页设置的密钥签名"
            : "Webhook 回调 —— 仅智能体所有者可查看和设置"}
        </span>
        <Input
          value={draft.webhookUrl}
          onChange={(e) => setDraft({ ...draft, webhookUrl: e.target.value })}
          placeholder={canManageWebhook ? "https://your-system/callback" : "(已隐藏)"}
          disabled={!canManageWebhook}
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
        {!schemaError && schemaText && <Badge variant="success">schema 合法 · 接口型智能体</Badge>}
      </div>

      {openedId && <KnowledgePanel agentId={openedId} canWrite={canWrite} />}

      {openedId && <SharePanel agentId={openedId} />}

      {openedId && (
        <InvokeSnippet
          agentId={openedId}
          inputSchema={parsedInputSchema}
          hasOutputSchema={Boolean(parsedSchema)}
        />
      )}
    </SpaceShell>
  );
}

/** 按 JSON Schema 生成一份示例值:给调用示例用,让复制下来的请求能直接通过入参校验。 */
function sampleFromSchema(schema: unknown, depth = 0): unknown {
  const sch = (schema ?? {}) as {
    type?: string | string[];
    properties?: Record<string, unknown>;
    items?: unknown;
    enum?: unknown[];
    example?: unknown;
    default?: unknown;
  };
  if (sch.example !== undefined) return sch.example;
  if (sch.default !== undefined) return sch.default;
  if (Array.isArray(sch.enum) && sch.enum.length > 0) return sch.enum[0];
  const type = Array.isArray(sch.type) ? sch.type[0] : sch.type;
  if (depth > 4) return null;
  switch (type) {
    case "object":
      return Object.fromEntries(
        Object.entries(sch.properties ?? {}).map(([k, v]) => [k, sampleFromSchema(v, depth + 1)]),
      );
    case "array":
      return [sampleFromSchema(sch.items, depth + 1)];
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    default:
      return "…";
  }
}

/**
 * 接口调用示例。
 *
 * 曾经是一段复制即 401 的 curl:没有 X-Api-Key、用相对地址、入参写死成纯文本
 * (声明了 inputSchema 的智能体会直接 400),而且只有填了 outputSchema 才显示。
 */
function InvokeSnippet({
  agentId,
  inputSchema,
  hasOutputSchema,
}: {
  agentId: string;
  inputSchema?: Record<string, unknown> | null;
  hasOutputSchema: boolean;
}) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const input = inputSchema ? sampleFromSchema(inputSchema) : "你的输入";
  const body = JSON.stringify({ input }, null, 2);
  const curl = `curl -X POST ${origin}/api/agents/${agentId}/invoke \\
  -H "X-Api-Key: $OWA_API_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '${body.replaceAll("'", "'\\''")}'
# → 202 { "taskId": "…" }

curl ${origin}/api/agents/<taskId>/result -H "X-Api-Key: $OWA_API_KEY"
# → { "status": "success", ${hasOutputSchema ? '"structured": { … }' : '"text": "…"'} }`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">接口调用</CardTitle>
        <CardDescription>
          在「设置 → 接入与 API Key」签发 Key 后,从你的后端调用(Key 不要放进浏览器)。
          {hasOutputSchema
            ? "已声明输出契约,结果在 structured 字段里。"
            : "未声明输出契约,结果是文本;要拿结构化 JSON 请填写输出 schema。"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <pre className="overflow-x-auto whitespace-pre font-mono text-xs text-muted-foreground">
          {curl}
        </pre>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigator.clipboard
              .writeText(curl)
              .then(() => toast.success("已复制调用示例"))
              .catch(() => toast.error("复制失败,请手动选择文本"))
          }
        >
          复制
        </Button>
      </CardContent>
    </Card>
  );
}
