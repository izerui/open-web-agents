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
import { EvalPanel } from "@/features/builder/eval-panel";
import { KnowledgePanel } from "@/features/builder/knowledge-panel";
import { ReleasePanel } from "@/features/builder/release-panel";
import { SharePanel } from "@/features/builder/share-panel";
import { InvokeSnippetTabs } from "@/features/integration/invoke-snippet";
import type { AgentSummary } from "@/features/workbench/types";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { ModelAlias } from "@/lib/shared";
import { PERMISSION_MODES, type PermissionMode } from "@/lib/shared";
import { isSafeSkillPath } from "@/lib/shared/skill-package";
import { cn } from "@/lib/utils";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  FileCode,
  FilePlus,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
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
  /** 模型别名;空 = 与主 agent 相同 */
  model: string;
}

function newSubagentRow(): SubagentDraft {
  return { uid: crypto.randomUUID(), name: "", description: "", prompt: "", model: "" };
}

/**
 * 技能包草稿:直接持有完整的 files 字典，SKILL.md 和附属文件（脚本、模板等）统一管理。
 */
interface SkillDraft {
  uid: string;
  name: string;
  description: string;
  files: Record<string, string>;
}

function newSkillRow(): SkillDraft {
  return { uid: crypto.randomUUID(), name: "", description: "", files: { "SKILL.md": "" } };
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
  /** 变量定义 */
  variables: VariableDraft[];
}

interface VariableDraft {
  uid: string;
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
}

type BuilderAgent = AgentSummary & { config: Record<string, unknown>; canRead?: boolean };

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
  variables: [],
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

/**
 * 平台内置、不能删除的智能体(与 DELETE /api/agents/{id} 的判定一致)。
 * 本地写常量而不是引 agent/domain/architect:那里带着整段设计师提示词与包解析逻辑,
 * 不该进前端包(工作台同样如此)。
 */
const BUILT_IN_AGENT_IDS = ["default", "agent-architect"];

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
          setList((d.agents ?? []).filter((agent) => agent.canRead !== false));
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
      router.push(`/agents/design?session=${encodeURIComponent(d.sessionId)}`);
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
                files: k.files,
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
                ...(s.model ? { model: s.model as ModelAlias } : {}),
                background: false,
              })),
            variables: draft.variables
              .filter((v) => v.name.trim())
              .map((v) => ({
                name: v.name.trim(),
                description: v.description.trim() || undefined,
                required: v.required,
                secret: v.secret,
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

  /** 软删除:接口调用、嵌入、分享随之失效;历史会话与运行记录保留。 */
  async function removeAgent(id: string, name: string) {
    if (
      !window.confirm(
        `删除「${name}」?\n\n删除后:接口调用、嵌入组件、分享立即失效,绑定它的 API Key 也调不通了;历史会话与运行记录保留。此操作不能在界面上撤销。`,
      )
    )
      return;
    try {
      await fetchJson(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast.success(`已删除「${name}」`);
      editSeqRef.current += 1;
      setCleanDraft(EMPTY);
      setOpenedId(null);
      loadedConfigRef.current = {};
      await reload();
    } catch (e) {
      toast.error(`删除失败:${errorText(e)}`);
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
        if (!full || full.canRead === false) return;
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
              ).map((k) => ({
                uid: crypto.randomUUID(),
                name: k.name,
                description: k.description,
                files: k.files ?? { "SKILL.md": "" },
              }))
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
            ? (
                cfg.subagents as {
                  name?: string;
                  description?: string;
                  prompt?: string;
                  model?: string;
                }[]
              ).map((s) => ({
                uid: crypto.randomUUID(),
                name: s.name ?? "",
                description: s.description ?? "",
                prompt: s.prompt ?? "",
                model: s.model ?? "",
              }))
            : [],
          variables: Array.isArray(cfg.variables)
            ? (
                cfg.variables as {
                  name?: string;
                  description?: string;
                  required?: boolean;
                  secret?: boolean;
                }[]
              ).map((v) => ({
                uid: crypto.randomUUID(),
                name: v.name ?? "",
                description: v.description ?? "",
                required: v.required === true,
                secret: v.secret === true,
              }))
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

  /**
   * 深链:/agents?id=xxx 直接打开该智能体(接入中心、运行记录等处跳过来)。
   * 只在列表第一次到手时处理一次,之后用户在侧栏里切换不受它干扰。
   */
  const deepLinkDoneRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只响应列表到手;edit 每次渲染都是新引用
  useEffect(() => {
    if (deepLinkDoneRef.current || list.length === 0) return;
    deepLinkDoneRef.current = true;
    const id = new URLSearchParams(window.location.search).get("id");
    const target = id ? list.find((a) => a.id === id) : undefined;
    if (target) edit(target);
  }, [list]);

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
        <KnowledgePanel key={selectedAgent.id} agentId={selectedAgent.id} canWrite={false} />
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
            {designing ? "准备中…" : openedId ? "AI 编辑" : "AI 创建"}
          </Button>
          {selectedAgent?.canManageWebhook && !BUILT_IN_AGENT_IDS.includes(selectedAgent.id) && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => void removeAgent(selectedAgent.id, selectedAgent.name)}
            >
              <Trash2 className="size-3.5" />
              删除
            </Button>
          )}
          {selectedAgent && canWrite && (
            <Badge
              variant={selectedAgent.hasUnpublishedChanges ? "warning" : "secondary"}
              title="接口调用、嵌入组件和其他用户使用已发布版本;发布在页面下方「版本与发布」"
            >
              {selectedAgent.publishedVersion
                ? `已发布 v${selectedAgent.publishedVersion}${selectedAgent.hasUnpublishedChanges ? " · 草稿有修改" : ""}`
                : "未发布"}
            </Badge>
          )}
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
                可复用的专门做法:流程、规范、脚本。描述写"何时使用",模型据此自动调用。 AI
                编辑可选择已有技能;技能正文与文件在这里维护。
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
            const patchFile = (path: string, content: string) => {
              patch({ files: { ...k.files, [path]: content } });
            };
            const removeFile = (path: string) => {
              const { [path]: _, ...rest } = k.files;
              patch({ files: rest });
            };
            const otherFiles = Object.keys(k.files).filter((p) => p !== "SKILL.md");
            return (
              <SkillEditor
                key={k.uid}
                skill={k}
                otherFiles={otherFiles}
                onPatch={patch}
                onPatchFile={patchFile}
                onRemoveFile={removeFile}
                onDelete={() =>
                  setDraft({
                    ...draft,
                    skillPackages: draft.skillPackages.filter((x) => x.uid !== k.uid),
                  })
                }
              />
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
                  <Select
                    className="max-w-[9rem]"
                    aria-label={`子代理 ${s.name || i + 1} 的模型`}
                    value={s.model}
                    onChange={(e) => {
                      const next = [...draft.subagents];
                      next[i] = { ...s, model: e.target.value };
                      setDraft({ ...draft, subagents: next });
                    }}
                  >
                    <option value="">同主 agent</option>
                    {["fable", "opus", "sonnet", "haiku"].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
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

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">变量与密钥</CardTitle>
              <CardDescription>
                使用者运行前需要填写的参数，引用方式: {"{{变量名}}"}
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setDraft({
                  ...draft,
                  variables: [
                    ...draft.variables,
                    {
                      uid: crypto.randomUUID(),
                      name: "",
                      description: "",
                      required: false,
                      secret: false,
                    },
                  ],
                })
              }
            >
              <Plus /> 添加
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {draft.variables.length === 0 && (
            <p className="text-xs text-muted-foreground">未定义变量，使用者不需要填写额外参数</p>
          )}
          {draft.variables.map((v, i) => (
            <div key={v.uid} className="space-y-2 border-b border-border pb-3 last:border-b-0">
              <div className="flex gap-2">
                <Input
                  value={v.name}
                  onChange={(e) => {
                    const next = [...draft.variables];
                    next[i] = {
                      ...v,
                      name: e.target.value.replace(/[^A-Za-z0-9_]/g, "").toUpperCase(),
                    };
                    setDraft({ ...draft, variables: next });
                  }}
                  placeholder="变量名 (如 API_KEY)"
                  className="font-mono"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`删除变量 ${v.name || i + 1}`}
                  onClick={() =>
                    setDraft({ ...draft, variables: draft.variables.filter((_, j) => j !== i) })
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <Input
                value={v.description}
                onChange={(e) => {
                  const next = [...draft.variables];
                  next[i] = { ...v, description: e.target.value };
                  setDraft({ ...draft, variables: next });
                }}
                placeholder="说明（给填写者看）"
              />
              <div className="flex gap-4 text-xs">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={v.required}
                    onChange={(e) => {
                      const next = [...draft.variables];
                      next[i] = { ...v, required: e.target.checked };
                      setDraft({ ...draft, variables: next });
                    }}
                  />
                  必填
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={v.secret}
                    onChange={(e) => {
                      const next = [...draft.variables];
                      next[i] = { ...v, secret: e.target.checked };
                      setDraft({ ...draft, variables: next });
                    }}
                  />
                  密钥（加密存储，不进提示词）
                </label>
              </div>
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

      {openedId && selectedAgent && canWrite && (
        <ReleasePanel
          agentId={openedId}
          publishedVersion={selectedAgent.publishedVersion ?? null}
          hasUnpublishedChanges={selectedAgent.hasUnpublishedChanges === true}
          unsaved={dirty}
          onChanged={reload}
          onRestored={async () => {
            await reload();
            // 草稿内容换了,表单重新从服务端读一遍
            edit(selectedAgent);
          }}
        />
      )}

      {openedId && selectedAgent && canWrite && (
        <EvalPanel
          agentId={openedId}
          publishedVersion={selectedAgent.publishedVersion ?? null}
          hasInputSchema={Boolean(parsedInputSchema)}
        />
      )}

      {openedId && <KnowledgePanel key={openedId} agentId={openedId} canWrite={canWrite} />}

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

function SkillEditor({
  skill,
  otherFiles,
  onPatch,
  onPatchFile,
  onRemoveFile,
  onDelete,
}: {
  skill: SkillDraft;
  otherFiles: string[];
  onPatch: (next: Partial<SkillDraft>) => void;
  onPatchFile: (path: string, content: string) => void;
  onRemoveFile: (path: string) => void;
  onDelete: () => void;
}) {
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [addingFile, setAddingFile] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);

  function addFile() {
    const p = newPath.trim();
    if (!p) return;
    if (p === "SKILL.md") {
      setPathError("SKILL.md 已存在");
      return;
    }
    if (p in skill.files) {
      setPathError("文件已存在");
      return;
    }
    if (!isSafeSkillPath(p)) {
      setPathError("路径不合法（只允许字母数字._-，不能 .. 或绝对路径）");
      return;
    }
    onPatchFile(p, "");
    setNewPath("");
    setPathError(null);
    setAddingFile(false);
    setExpandedFile(p);
  }

  return (
    <div className="space-y-2 border-b border-border pb-3 last:border-b-0">
      <div className="flex gap-2">
        <Input
          value={skill.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="技能名(小写字母、数字、连字符)"
          aria-label="技能名"
        />
        <Button variant="ghost" size="sm" aria-label="删除这个技能" onClick={onDelete}>
          <Trash2 />
        </Button>
      </div>
      <Input
        value={skill.description}
        onChange={(e) => onPatch({ description: e.target.value })}
        placeholder="何时使用,如:需要把数学推导做成动画时使用"
        aria-label="技能描述"
      />

      {/* SKILL.md 置顶 */}
      <div className="rounded border border-border">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/50"
          onClick={() => setExpandedFile(expandedFile === "SKILL.md" ? null : "SKILL.md")}
        >
          {expandedFile === "SKILL.md" ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <FileCode className="size-3.5 shrink-0" />
          <span className="flex-1 font-medium">SKILL.md</span>
          <span className="text-muted-foreground">
            {(skill.files["SKILL.md"] ?? "").length} 字符
          </span>
        </button>
        {expandedFile === "SKILL.md" && (
          <div className="border-t px-2 py-1.5">
            <Textarea
              className="h-32 resize-y font-mono text-xs"
              value={skill.files["SKILL.md"] ?? ""}
              onChange={(e) => onPatchFile("SKILL.md", e.target.value)}
              placeholder="SKILL.md 正文:步骤、约定、示例"
            />
          </div>
        )}
      </div>

      {/* 附属文件 */}
      {otherFiles.map((path) => (
        <div key={path} className="rounded border border-border">
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
            <button
              type="button"
              className="flex flex-1 items-center gap-2 text-left hover:opacity-80"
              onClick={() => setExpandedFile(expandedFile === path ? null : path)}
            >
              {expandedFile === path ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate font-mono">{path}</span>
            </button>
            <span className="shrink-0 text-muted-foreground">
              {skill.files[path]?.length ?? 0} 字符
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={`删除 ${path}`}
              onClick={() => {
                onRemoveFile(path);
                if (expandedFile === path) setExpandedFile(null);
              }}
            >
              <Trash2 />
            </Button>
          </div>
          {expandedFile === path && (
            <div className="border-t px-2 py-1.5">
              <Textarea
                className="h-32 resize-y font-mono text-xs"
                value={skill.files[path] ?? ""}
                onChange={(e) => onPatchFile(path, e.target.value)}
                placeholder={`${path} 内容`}
              />
            </div>
          )}
        </div>
      ))}

      {/* 添加文件 */}
      {addingFile ? (
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <Input
              value={newPath}
              onChange={(e) => {
                setNewPath(e.target.value);
                setPathError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && addFile()}
              placeholder="文件路径，如 scripts/render.py"
              autoFocus
            />
            {pathError && <p className="mt-1 text-xs text-destructive">{pathError}</p>}
          </div>
          <Button type="button" size="sm" onClick={addFile} disabled={!newPath.trim()}>
            确定
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setAddingFile(false);
              setNewPath("");
              setPathError(null);
            }}
          >
            取消
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setAddingFile(true)}
        >
          <FilePlus className="size-3.5" />
          添加文件
        </Button>
      )}
    </div>
  );
}

/**
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">接口调用</CardTitle>
        <CardDescription>
          在「接入中心」签发 Key 后,从你的后端调用(Key 不要放进浏览器)。
          {hasOutputSchema
            ? "已声明输出契约,结果在 structured 字段里。"
            : "未声明输出契约,结果是文本;要拿结构化 JSON 请填写输出 schema。"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <InvokeSnippetTabs
          agentId={agentId}
          inputSchema={inputSchema}
          hasOutputSchema={hasOutputSchema}
        />
      </CardContent>
    </Card>
  );
}
