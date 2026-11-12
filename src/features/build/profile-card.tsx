"use client";

// 档案卡:九节,每节一行摘要,点开就地编辑,改动自动保存(编排阶段右栏「档案」页签)。
// 字段与校验承接原 Builder 的配置、能力、知识、安全与契约四个分区(features.md 2.3.1–2.3.4)。

import { AgentAvatar } from "@/components/agent-avatar";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { KnowledgePanel } from "@/features/builder/knowledge-panel";
import { McpCheck } from "@/features/builder/mcp-check";
import { type ModelCatalog, ModelSelect, modelOf } from "@/features/builder/model-select";
import { AVATAR_COLORS, type AvatarEyes, avatarStyle, formatAvatarIcon } from "@/lib/agent-avatar";
import { PERMISSION_MODES, isModelAlias } from "@/lib/shared";
import { cn } from "@/lib/utils";
import {
  AlignLeft,
  BookOpen,
  Braces,
  ChevronRight,
  Cpu,
  KeyRound,
  Layers,
  Plus,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  User,
  Webhook,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import type { Stage } from "./build-model";
import { DesignSources } from "./design-sources";
import {
  EFFORTS,
  PERMISSION_META,
  type ProfileDraft,
  SECTIONS,
  type SectionContext,
  type SectionKey,
  UNATTENDED,
  advancedError,
  envError,
  idError,
  mcpOfRow,
  newMcp,
  newSkill,
  newSubagent,
  newVariable,
  normalizeVarName,
  parseSchemaText,
  sectionFilled,
  sectionSummary,
  startersHint,
} from "./profile-model";
import { SkillItem } from "./skill-editor";
import { Banner, Field, RadioRow, Seg, SubHead, Tag, TextButton, inputMono } from "./ui";
import type { Designer } from "./use-designer";

const ICONS: Record<SectionKey, ReactNode> = {
  identity: <User />,
  prompt: <AlignLeft />,
  model: <Cpu />,
  ability: <Wrench />,
  knowledge: <BookOpen />,
  vars: <KeyRound />,
  contract: <Braces />,
  approval: <ShieldCheck />,
  webhook: <Webhook />,
};

const OUTPUT_EXAMPLE = `{
  "type": "object",
  "properties": {
    "verdict": { "type": "string", "enum": ["pass", "needs_work"] },
    "issues": { "type": "array", "items": { "type": "string" } },
    "score": { "type": "integer", "minimum": 0, "maximum": 100 }
  },
  "required": ["verdict", "issues", "score"],
  "additionalProperties": false
}`;

const INPUT_EXAMPLE = `{
  "type": "object",
  "properties": {
    "topic": { "type": "string", "minLength": 1 },
    "level": { "type": "string", "enum": ["basic", "advanced"] }
  },
  "required": ["topic"],
  "additionalProperties": false
}`;

const uid = () => crypto.randomUUID();
const EYES: readonly AvatarEyes[] = ["pill", "round", "side", "dot"];

export interface ProfileProps {
  draft: ProfileDraft;
  set: (patch: Partial<ProfileDraft>) => void;
  update: (fn: (d: ProfileDraft) => ProfileDraft) => void;
  /** 已建好的智能体 id;新建且还没保存时为 null */
  agentId: string | null;
  canManageWebhook: boolean;
  /** 分享给我、可编辑(非所有者) */
  sharedWrite: boolean;
  publishedVersion: number | null;
  changeCount: number | null;
  catalog: ModelCatalog | null;
  stdio: boolean;
  knowledge: SectionContext["knowledge"];
  onKnowledgeChanged: () => void;
  fresh: ReadonlySet<SectionKey>;
  onEdited: (k: SectionKey) => void;
  open: ReadonlySet<SectionKey>;
  onToggle: (k: SectionKey, open?: boolean) => void;
  takenIds: readonly string[];
  designer: Designer;
  sources: { id: string; name: string; icon?: string }[];
  goStage: (s: Stage) => void;
}

export function modelLabel(catalog: ModelCatalog | null, ref: string): string {
  const m = modelOf(catalog, ref);
  if (isModelAlias(ref)) {
    return `跟随平台默认（${ref}${m ? `，当前 ${m.name}` : ""}）`;
  }
  if (!m) return catalog ? `${ref}（已停用）` : ref;
  return m.name;
}

export function ProfileCard(p: ProfileProps) {
  const { draft: d } = p;
  const ctx: SectionContext = {
    exists: p.agentId !== null,
    canManageWebhook: p.canManageWebhook,
    modelLabel: modelLabel(p.catalog, d.model),
    knowledge: p.knowledge,
  };
  const filled = SECTIONS.filter((s) => sectionFilled(s.key, d, ctx)).length;
  const allOpen = SECTIONS.every((s) => p.open.has(s.key));

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-4 border-b border-line-soft pb-[18px]">
        <AgentAvatar id={d.id || "new-agent"} icon={d.icon || null} size={64} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-2xl leading-tight font-bold">
            {d.name.trim() || "还没起名字"}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
            {d.description.trim() ||
              "智能体设计器会根据你的描述写好这一页，也可以直接点开下面各节手动填"}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Tag line className={inputMono}>
              {p.agentId ?? (d.id.trim() || "ID 待生成")}
            </Tag>
            <Tag>{p.publishedVersion ? `已发布 v${p.publishedVersion}` : "未发布"}</Tag>
            {p.publishedVersion !== null && (p.changeCount ?? 0) > 0 && (
              <Tag tone="warn">{p.changeCount} 处未发布修改</Tag>
            )}
            <Tag tone={filled === 9 ? "ok" : ""}>{filled}/9 节已填</Tag>
            {p.sharedWrite && <Tag line>分享给我，可编辑</Tag>}
          </div>
        </div>
        <TextButton
          className="self-start max-md:hidden"
          onClick={() => {
            for (const s of SECTIONS) p.onToggle(s.key, !allOpen);
          }}
        >
          {allOpen ? "全部收起" : "全部展开"}
        </TextButton>
      </div>
      {SECTIONS.map((s) => {
        const isFresh = p.fresh.has(s.key);
        const isOpen = p.open.has(s.key);
        const empty = !sectionFilled(s.key, d, ctx);
        return (
          <div
            key={s.key}
            data-sec={s.key}
            className={cn(
              "scroll-mt-3 rounded-xl border-b border-line-soft transition-colors",
              isFresh && "bg-fresh",
            )}
          >
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => p.onToggle(s.key)}
              className="flex min-h-[52px] w-full items-center gap-3 px-3 py-[13px] text-left max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-1"
            >
              <span
                className={cn(
                  "grid size-[30px] shrink-0 place-items-center rounded-[9px] bg-[#F1EFEA] text-[#4D4A43] [&_svg]:size-4",
                  empty && "border border-dashed border-[#C9C4B8] bg-card",
                )}
              >
                {ICONS[s.key]}
              </span>
              <span className="w-24 shrink-0 font-semibold max-md:w-auto max-md:flex-1">
                {s.title}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground max-md:order-last max-md:basis-full max-md:pl-[42px] max-md:whitespace-normal max-md:line-clamp-2">
                {sectionSummary(s.key, d, ctx)}
              </span>
              {isFresh && (
                <span className="inline-flex h-[22px] shrink-0 items-center rounded-full bg-[#FBE7BD] px-2 text-xs text-[#7A4F0C]">
                  刚更新
                </span>
              )}
              <ChevronRight
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  isOpen && "rotate-90",
                )}
              />
            </button>
            {isOpen && (
              <div
                className="px-3 pt-1 pb-[18px] pl-[54px] max-md:pl-3"
                onChangeCapture={() => p.onEdited(s.key)}
              >
                <SectionBody k={s.key} {...p} ctx={ctx} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SectionBody(props: ProfileProps & { k: SectionKey; ctx: SectionContext }) {
  switch (props.k) {
    case "identity":
      return <IdentityBody {...props} />;
    case "prompt":
      return <PromptBody {...props} />;
    case "model":
      return <ModelBody {...props} />;
    case "ability":
      return <AbilityBody {...props} />;
    case "knowledge":
      return props.agentId ? (
        <div onClickCapture={() => setTimeout(props.onKnowledgeChanged, 1500)}>
          <KnowledgePanel key={props.agentId} agentId={props.agentId} canWrite />
        </div>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">
          填好名称和提示词后会自动建好草稿，就能上传知识文档了。
        </p>
      );
    case "vars":
      return <VarsBody {...props} />;
    case "contract":
      return <ContractBody {...props} />;
    case "approval":
      return <ApprovalBody {...props} />;
    case "webhook":
      return <WebhookBody {...props} />;
  }
}

function IdentityBody({ draft: d, set, agentId, takenIds }: ProfileProps) {
  const style = avatarStyle(d.id || "new-agent", d.icon || null);
  const hint = startersHint(d.startersText);
  const creating = agentId === null;
  return (
    <>
      <Field label="头像" hint="市场、对话、工作室里用同一个头像">
        <div className="flex flex-wrap items-center gap-2">
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`头像颜色 ${c}`}
              aria-pressed={style.color === c}
              onClick={() => set({ icon: formatAvatarIcon({ color: c, eyes: style.eyes }) })}
              className="size-8 rounded-full max-md:size-11"
              style={{
                background: c,
                boxShadow:
                  style.color === c
                    ? "0 0 0 2px #fff, 0 0 0 4px #1C1C1C"
                    : "inset 0 0 0 1px rgba(0,0,0,.08)",
              }}
            />
          ))}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {EYES.map((e) => (
            <button
              key={e}
              type="button"
              aria-label={`眼睛样式 ${e}`}
              aria-pressed={style.eyes === e}
              onClick={() => set({ icon: formatAvatarIcon({ color: style.color, eyes: e }) })}
              className={cn(
                "rounded-full p-0.5",
                style.eyes === e && "ring-2 ring-foreground ring-offset-2",
              )}
            >
              <AgentAvatar
                id={d.id || "new-agent"}
                icon={formatAvatarIcon({ color: style.color, eyes: e })}
                size={32}
              />
            </button>
          ))}
        </div>
      </Field>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field
          label="名称"
          required
          error={d.name.trim() ? undefined : "名称是必填项，填好后才会自动保存"}
        >
          <Input
            aria-label="名称"
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="例如 报销审核助手"
          />
        </Field>
        <Field
          label={creating ? "ID（留空自动生成，建好后不能再改）" : "ID（建好后不能改）"}
          error={creating ? idError(d.id, takenIds) || undefined : undefined}
        >
          <Input
            aria-label="ID"
            className={inputMono}
            value={creating ? d.id : (agentId ?? "")}
            disabled={!creating}
            onChange={(e) => set({ id: e.target.value })}
            placeholder="例如 expense-audit"
          />
        </Field>
      </div>
      <Field label="描述">
        <Input
          aria-label="描述"
          value={d.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="一句话说明它做什么，会显示在市场与对话里"
        />
      </Field>
      <Field
        label="开场建议（一行一条，最多 4 条）"
        hint={<span className={hint.over ? "text-warning-text" : ""}>{hint.text}</span>}
      >
        <Textarea
          aria-label="开场建议"
          className="min-h-24 resize-y"
          value={d.startersText}
          onChange={(e) => set({ startersText: e.target.value })}
          placeholder={"审一下这份合同的付款条款\n把附件里的发票抽成表格"}
        />
      </Field>
    </>
  );
}

function PromptBody({ draft: d, set }: ProfileProps) {
  const vars = d.variables.filter((v) => v.name.trim() && !v.secret);
  return (
    <Field label="系统提示词" required>
      <Textarea
        aria-label="系统提示词"
        className={cn("min-h-64 resize-y leading-relaxed", inputMono)}
        value={d.systemPrompt}
        onChange={(e) => set({ systemPrompt: e.target.value })}
        placeholder={"# 角色\n你是……\n## 规则\n1. ……"}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] text-muted-foreground">插入变量</span>
          {vars.length ? (
            vars.map((v) => (
              <button
                key={v.uid}
                type="button"
                onClick={() => set({ systemPrompt: `${d.systemPrompt}{{${v.name}}}` })}
                className="inline-flex h-7 items-center rounded-full bg-[#F1EFEA] px-2.5 font-mono text-xs text-[#4D4A43] hover:bg-[#E6E3DB]"
              >
                {`{{${v.name}}}`}
              </button>
            ))
          ) : (
            <span className="text-[13px] text-muted-foreground">还没有非密钥变量</span>
          )}
        </div>
        <span className="text-[13px] text-muted-foreground">
          {d.systemPrompt.length.toLocaleString()} 字
        </span>
      </div>
      <span className="text-[13px] text-muted-foreground">
        可用 {"{{变量名}}"} 引用变量；密钥类变量不会进提示词。
        {!d.systemPrompt.trim() && (
          <span className="text-destructive">提示词是必填项，填好后才会自动保存。</span>
        )}
      </span>
    </Field>
  );
}

function ModelBody({ draft: d, set, catalog }: ProfileProps) {
  const [advOpen, setAdvOpen] = useState(Boolean(d.advancedText.trim()));
  const advErr = advancedError(d.advancedText);
  return (
    <>
      <Field
        label="模型"
        hint="价格来自平台价目表（积分/百万 token）；选「跟随平台默认」时随管理员的默认路由变化。"
      >
        <ModelSelect
          ariaLabel="模型"
          catalog={catalog}
          value={d.model}
          onChange={(model) => set({ model })}
        />
      </Field>
      {catalog?.aliases && (
        <div className="-mt-2 mb-3 flex flex-wrap gap-1.5">
          {Object.keys(catalog.aliases).map((alias) => (
            <TextButton
              key={alias}
              className={cn("border border-border", d.model === alias && "bg-accent font-medium")}
              onClick={() => set({ model: alias })}
            >
              跟随平台默认（{alias}）
            </TextButton>
          ))}
        </div>
      )}
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="最大轮次" hint="默认 20，达到后运行以「max_turns」结束">
          <Input
            aria-label="最大轮次"
            type="number"
            min={1}
            max={200}
            value={d.maxTurns}
            onChange={(e) => set({ maxTurns: Number(e.target.value) })}
          />
        </Field>
        <Field label="推理强度 effort" hint="越高思考越充分，耗时与花费也越高">
          <Seg
            ariaLabel="推理强度"
            options={EFFORTS}
            value={d.effort}
            onChange={(effort) => set({ effort })}
          />
        </Field>
      </div>
      <SubHead right={<Tag tone={advErr ? "bad" : "ok"}>{advErr ? "有误" : "合法"}</Tag>}>
        <TextButton
          className="pl-0 font-semibold"
          aria-expanded={advOpen}
          onClick={() => setAdvOpen(!advOpen)}
        >
          <ChevronRight className={cn("transition-transform", advOpen && "rotate-90")} />
          高级参数（parameters JSON）
        </TextButton>
      </SubHead>
      {advOpen && (
        <Field
          label="表单里没有的参数"
          error={advErr ?? undefined}
          hint="可写 approvalRules.all 等表单里没有的参数；不能包含 name、description、systemPrompt、skills、skillPackages、mcpServers、escapeHatch（这些在对应的节里改，逃生舱不允许在这里改）。"
        >
          <Textarea
            aria-label="高级参数"
            className={cn("min-h-28 resize-y", inputMono)}
            value={d.advancedText}
            onChange={(e) => set({ advancedText: e.target.value })}
            placeholder={'{\n  "approvalRules": { "all": false }\n}'}
          />
        </Field>
      )}
    </>
  );
}

function AbilityBody(p: ProfileProps) {
  const { draft: d, set, update, catalog, stdio, agentId } = p;
  const [openMcp, setOpenMcp] = useState<Set<string>>(() => new Set());
  const [openSub, setOpenSub] = useState<Set<string>>(() => new Set());
  const mainGroup = modelOf(catalog, d.model)?.group;
  const toggle = (s: Set<string>, id: string, fn: (s: Set<string>) => void) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    fn(n);
  };
  return (
    <>
      <Field label="工具白名单（逗号分隔，留空表示不限制）">
        <Input
          aria-label="工具白名单"
          className={inputMono}
          value={d.toolsText}
          onChange={(e) => set({ toolsText: e.target.value })}
          placeholder="例如 Read, Grep, WebFetch"
        />
      </Field>

      <SubHead
        right={
          <TextButton
            onClick={() =>
              update((x) => ({ ...x, skillPackages: [...x.skillPackages, newSkill(uid())] }))
            }
          >
            <Plus />
            添加技能包
          </TextButton>
        }
      >
        技能包（{d.skillPackages.length}）
      </SubHead>
      {d.skillPackages.length === 0 && (
        <p className="mb-2 text-sm text-muted-foreground">未配置技能</p>
      )}
      {d.skillPackages.map((k) => (
        <SkillItem
          key={k.uid}
          skill={k}
          onPatch={(next) =>
            update((x) => ({
              ...x,
              skillPackages: x.skillPackages.map((s) => (s.uid === k.uid ? { ...s, ...next } : s)),
            }))
          }
          onDelete={() =>
            update((x) => ({ ...x, skillPackages: x.skillPackages.filter((s) => s.uid !== k.uid) }))
          }
        />
      ))}

      <SubHead
        right={
          <TextButton
            onClick={() => {
              const row = newMcp(uid());
              setOpenMcp((s) => new Set(s).add(row.uid));
              update((x) => ({ ...x, mcpServers: [...x.mcpServers, row] }));
            }}
          >
            <Plus />
            添加 MCP
          </TextButton>
        }
      >
        MCP 服务（{d.mcpServers.length}）
      </SubHead>
      {d.mcpServers.length === 0 && (
        <p className="mb-2 text-sm text-muted-foreground">未配置 MCP 服务</p>
      )}
      {d.mcpServers.map((m, i) => {
        const on = openMcp.has(m.uid) || !m.name;
        const patchRow = (next: Partial<typeof m>) =>
          update((x) => ({
            ...x,
            mcpServers: x.mcpServers.map((r) => (r.uid === m.uid ? { ...r, ...next } : r)),
          }));
        const envErr = m.type === "stdio" ? envError(m.envText) : "";
        return (
          <div key={m.uid} className="mb-2 rounded-xl border border-border bg-card">
            <div className="flex min-h-12 flex-wrap items-center gap-2.5 px-3 py-2.5">
              <Layers className="size-4 shrink-0 text-muted-foreground" />
              <b className={cn("font-semibold", inputMono)}>{m.name || "未命名"}</b>
              <Tag>{m.type}</Tag>
              <span className={cn("min-w-0 flex-1 truncate text-muted-foreground", inputMono)}>
                {m.type === "http" ? m.url : m.command}
              </span>
              <TextButton onClick={() => toggle(openMcp, m.uid, setOpenMcp)} aria-expanded={on}>
                {on ? "收起" : "编辑"}
              </TextButton>
              <TextButton
                aria-label={`删除 MCP 服务 ${m.name || i + 1}`}
                onClick={() =>
                  update((x) => ({ ...x, mcpServers: x.mcpServers.filter((r) => r.uid !== m.uid) }))
                }
              >
                <Trash2 />
              </TextButton>
            </div>
            <div className="px-3 pb-2.5">
              <McpCheck
                name={m.name || `第 ${i + 1} 个`}
                resetKey={JSON.stringify([m.type, m.url, m.command, m.argsText, m.envText])}
                requestAction={() => ({
                  url: "/api/agents/mcp-check",
                  body: {
                    // 打开的是已保存的智能体:变量值取本人在它上面保存的
                    agentId: agentId ?? undefined,
                    server: mcpOfRow(m),
                    variables: d.variables
                      .filter((v) => v.name.trim())
                      .map((v) => ({
                        name: v.name.trim(),
                        required: v.required,
                        secret: v.secret,
                      })),
                  },
                })}
              />
            </div>
            {on && (
              <div className="border-t border-line-soft px-3.5 pt-2.5 pb-3.5">
                <div className="grid gap-x-3 sm:grid-cols-2">
                  <Field label="名称（字母、数字、_、-）">
                    <Input
                      aria-label="MCP 名称"
                      className={inputMono}
                      value={m.name}
                      onChange={(e) => patchRow({ name: e.target.value })}
                      placeholder="erp-finance"
                    />
                  </Field>
                  <Field label="类型">
                    <Seg
                      ariaLabel="MCP 类型"
                      options={[
                        ["http", "http"],
                        [
                          "stdio",
                          stdio ? "stdio" : "stdio（平台未启用）",
                          { disabled: !stdio, title: stdio ? undefined : "平台未启用 stdio" },
                        ],
                      ]}
                      value={m.type}
                      onChange={(type) => patchRow({ type })}
                    />
                  </Field>
                </div>
                {m.type === "http" ? (
                  <Field label="URL">
                    <Input
                      aria-label="MCP URL"
                      className={inputMono}
                      value={m.url}
                      onChange={(e) => patchRow({ url: e.target.value })}
                      placeholder="https://mcp.example.com"
                    />
                  </Field>
                ) : (
                  <>
                    <Field label="command">
                      <Input
                        aria-label="MCP command"
                        className={inputMono}
                        value={m.command}
                        onChange={(e) => patchRow({ command: e.target.value })}
                        placeholder="npx"
                      />
                    </Field>
                    <div className="grid gap-x-3 sm:grid-cols-2">
                      <Field label="args（每行一个）">
                        <Textarea
                          aria-label="MCP args"
                          className={cn("min-h-24 resize-y", inputMono)}
                          value={m.argsText}
                          onChange={(e) => patchRow({ argsText: e.target.value })}
                          placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                        />
                      </Field>
                      <Field label="env（字符串键值 JSON）" error={envErr || undefined}>
                        <Textarea
                          aria-label="MCP env"
                          className={cn("min-h-24 resize-y", inputMono)}
                          value={m.envText}
                          onChange={(e) => patchRow({ envText: e.target.value })}
                          placeholder={'{"GITHUB_TOKEN":"{{GITHUB_TOKEN}}"}'}
                        />
                      </Field>
                    </div>
                  </>
                )}
                <p className="m-0 text-[13px] text-muted-foreground">
                  测试连接只列出工具，不会调用；值里可以用 {"{{变量名}}"}
                  ，测试时带上你保存过的变量值。
                </p>
              </div>
            )}
          </div>
        );
      })}

      <SubHead
        right={
          <TextButton
            onClick={() => {
              const row = newSubagent(uid());
              setOpenSub((s) => new Set(s).add(row.uid));
              update((x) => ({ ...x, subagents: [...x.subagents, row] }));
            }}
          >
            <Plus />
            添加子代理
          </TextButton>
        }
      >
        子代理（{d.subagents.length}）
      </SubHead>
      {d.subagents.length === 0 && (
        <p className="mb-2 text-sm text-muted-foreground">未配置子代理</p>
      )}
      {d.subagents.map((s, i) => {
        const on = openSub.has(s.uid) || !s.name;
        const patchRow = (next: Partial<typeof s>) =>
          update((x) => ({
            ...x,
            subagents: x.subagents.map((r) => (r.uid === s.uid ? { ...r, ...next } : r)),
          }));
        return (
          <div key={s.uid} className="mb-2 rounded-xl border border-border bg-card">
            <div className="flex min-h-12 items-center gap-2.5 px-3 py-2.5">
              <AgentAvatar id={s.name || `sub-${i}`} size={22} />
              <b className={cn("shrink-0 font-semibold", inputMono)}>{s.name || "未命名"}</b>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {s.description}
              </span>
              <Tag className="max-sm:hidden">
                {s.model ? (modelOf(catalog, s.model)?.name ?? s.model) : "同主 agent"}
              </Tag>
              <TextButton onClick={() => toggle(openSub, s.uid, setOpenSub)} aria-expanded={on}>
                {on ? "收起" : "编辑"}
              </TextButton>
              <TextButton
                aria-label={`删除子代理 ${s.name || i + 1}`}
                onClick={() =>
                  update((x) => ({ ...x, subagents: x.subagents.filter((r) => r.uid !== s.uid) }))
                }
              >
                <Trash2 />
              </TextButton>
            </div>
            {on && (
              <div className="border-t border-line-soft px-3.5 pt-2.5 pb-3.5">
                <div className="grid gap-x-3 sm:grid-cols-2">
                  <Field label="名称">
                    <Input
                      aria-label="子代理名称"
                      className={inputMono}
                      value={s.name}
                      onChange={(e) => patchRow({ name: e.target.value })}
                      placeholder="reviewer"
                    />
                  </Field>
                  <Field label="模型">
                    <ModelSelect
                      ariaLabel={`子代理 ${s.name || i + 1} 的模型`}
                      catalog={catalog}
                      group={mainGroup}
                      inheritLabel="同主 agent"
                      value={s.model}
                      onChange={(model) => patchRow({ model })}
                    />
                  </Field>
                </div>
                <Field label="何时使用">
                  <Input
                    aria-label="子代理何时使用"
                    value={s.description}
                    onChange={(e) => patchRow({ description: e.target.value })}
                    placeholder="需要审阅代码质量时"
                  />
                </Field>
                <Field label="提示词">
                  <Textarea
                    aria-label="子代理提示词"
                    className="min-h-20 resize-y"
                    value={s.prompt}
                    onChange={(e) => patchRow({ prompt: e.target.value })}
                    placeholder="这个子代理的职责与要求"
                  />
                </Field>
                <p className="m-0 text-[13px] text-muted-foreground">
                  名称和提示词都填了才会生效；子代理在前台运行，不支持后台。
                </p>
              </div>
            )}
          </div>
        );
      })}

      <DesignSources
        designer={p.designer}
        sources={p.sources}
        inlineSkills={d.skillPackages.map((s) => s.name)}
        inlineMcps={d.mcpServers.map((m) => m.name)}
        canStart={agentId !== null}
      />
    </>
  );
}

function VarsBody({ draft: d, update }: ProfileProps) {
  const patchRow = (id: string, next: Partial<ProfileDraft["variables"][number]>) =>
    update((x) => ({
      ...x,
      variables: x.variables.map((v) => (v.uid === id ? { ...v, ...next } : v)),
    }));
  return (
    <>
      <p className="mt-0 mb-2.5 text-sm text-muted-foreground">
        在提示词、MCP 配置里用 {"{{变量名}}"}{" "}
        引用。每个使用者在对话里填自己的值；密钥类变量加密存储，不进提示词。
      </p>
      <div className="mb-2.5 overflow-hidden rounded-xl border border-border">
        {d.variables.length === 0 ? (
          <div className="px-3 py-2.5 text-sm text-muted-foreground">
            未定义变量。需要每个使用者提供的值（如令牌、部门）时添加。
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[minmax(0,170px)_minmax(0,1fr)_64px_64px_36px] gap-2 border-b border-line-soft px-2.5 py-1.5 text-xs text-muted-foreground max-md:hidden">
              <span>变量名</span>
              <span>说明</span>
              <span>必填</span>
              <span>密钥</span>
              <span />
            </div>
            {d.variables.map((v) => (
              <div
                key={v.uid}
                className="grid grid-cols-[minmax(0,170px)_minmax(0,1fr)_64px_64px_36px] items-center gap-2 border-b border-line-soft px-2.5 py-2 last:border-0 max-md:grid-cols-2"
              >
                <Input
                  aria-label="变量名"
                  className={inputMono}
                  value={v.name}
                  onChange={(e) => patchRow(v.uid, { name: normalizeVarName(e.target.value) })}
                  placeholder="ERP_TOKEN"
                />
                <Input
                  aria-label="变量说明"
                  value={v.description}
                  onChange={(e) => patchRow(v.uid, { description: e.target.value })}
                  placeholder="说明（给填写者看）"
                />
                <label className="flex items-center gap-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    className="size-4 accent-[#1C1C1C]"
                    checked={v.required}
                    onChange={(e) => patchRow(v.uid, { required: e.target.checked })}
                  />
                  必填
                </label>
                <label className="flex items-center gap-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    className="size-4 accent-[#1C1C1C]"
                    checked={v.secret}
                    onChange={(e) => patchRow(v.uid, { secret: e.target.checked })}
                  />
                  密钥
                </label>
                <TextButton
                  aria-label={`删除变量 ${v.name || ""}`}
                  onClick={() =>
                    update((x) => ({ ...x, variables: x.variables.filter((r) => r.uid !== v.uid) }))
                  }
                >
                  <Trash2 />
                </TextButton>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => update((x) => ({ ...x, variables: [...x.variables, newVariable(uid())] }))}
          className="inline-flex h-8 items-center gap-1 rounded-full border border-border bg-card px-3.5 text-[13px] hover:bg-[#F2F0EA] max-md:h-11"
        >
          <Plus className="size-3.5" />
          添加变量
        </button>
        <span className="text-[13px] text-muted-foreground">
          变量名自动转大写，只保留 A-Z、0-9、_
        </span>
      </div>
    </>
  );
}

function SchemaField({
  label,
  value,
  onChange,
  placeholder,
  extra,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  extra?: ReactNode;
}) {
  const r = parseSchemaText(value);
  return (
    <div className="mb-3.5 flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <span>{label}</span>
        <Tag tone={r.ok && r.empty ? "" : r.ok ? "ok" : "bad"}>
          {r.ok && r.empty ? "未填，文本" : r.ok ? "schema 合法" : "schema 有误"}
        </Tag>
        {extra && <span className="ml-auto">{extra}</span>}
      </div>
      <Textarea
        aria-label={label}
        className={cn("min-h-56 resize-y", inputMono)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {!r.ok && <span className="text-xs text-destructive">{r.error}</span>}
    </div>
  );
}

function ContractBody({ draft: d, set, goStage }: ProfileProps) {
  return (
    <>
      <div className="grid gap-x-3 lg:grid-cols-2">
        <SchemaField
          label="输入 inputSchema（可选）"
          value={d.inputSchemaText}
          onChange={(v) => set({ inputSchemaText: v })}
          placeholder={INPUT_EXAMPLE}
        />
        <SchemaField
          label="输出 outputSchema（可选）"
          value={d.outputSchemaText}
          onChange={(v) => set({ outputSchemaText: v })}
          placeholder={OUTPUT_EXAMPLE}
          extra={
            <TextButton className="h-7" onClick={() => set({ outputSchemaText: OUTPUT_EXAMPLE })}>
              填入示例 schema
            </TextButton>
          }
        />
      </div>
      <p className="m-0 text-[13px] text-muted-foreground">
        填了 inputSchema 后，接口调用的入参不符合会返回 400；填了
        outputSchema，结果里会带结构化字段，留空仍可通过接口调用并返回文本。
        <button type="button" className="ml-1 underline" onClick={() => goStage("access")}>
          去接入看调用示例
        </button>
      </p>
    </>
  );
}

function ApprovalBody({ draft: d, set }: ProfileProps) {
  return (
    <>
      <SubHead>权限模式（按使用场景选，不是安全等级）</SubHead>
      <fieldset
        aria-label="权限模式"
        className="m-0 grid min-w-0 gap-x-3 gap-y-0.5 border-0 p-0 sm:grid-cols-2"
      >
        {PERMISSION_MODES.map((m) => (
          <RadioRow
            key={m}
            on={d.permissionMode === m}
            onSelect={() => set({ permissionMode: m })}
            title={PERMISSION_META[m].label}
            hint={PERMISSION_META[m].hint}
          />
        ))}
      </fieldset>
      {d.permissionMode === "bypassPermissions" && (
        <Banner tone="warn" icon={<TriangleAlert />} className="mt-2 mb-0">
          跳过权限检查时，子代理会一并继承该模式，无法单独收紧。
        </Banner>
      )}
      <SubHead>
        <span>
          无人值守审批
          <span className="ml-2 text-[13px] font-normal text-muted-foreground">
            网页里始终等人审批；这里只管接口调用等没有审批人的入口
          </span>
        </span>
      </SubHead>
      <fieldset
        aria-label="无人值守审批"
        className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0"
      >
        {UNATTENDED.map(([v, label, hint]) => (
          <RadioRow
            key={v || "entry"}
            inline
            on={d.unattendedApproval === v}
            onSelect={() => set({ unattendedApproval: v })}
            title={label}
            hint={hint}
          />
        ))}
      </fieldset>
      <div className="mt-3 grid gap-x-3 sm:grid-cols-2">
        <Field label="需审批的工具（逗号分隔）">
          <Input
            aria-label="需审批的工具"
            className={inputMono}
            value={d.approvalToolsText}
            onChange={(e) => set({ approvalToolsText: e.target.value })}
            placeholder="例如 Bash, Write"
          />
        </Field>
        <Field label="需审批的命令模式（逗号分隔）">
          <Input
            aria-label="需审批的命令模式"
            className={inputMono}
            value={d.approvalPatternsText}
            onChange={(e) => set({ approvalPatternsText: e.target.value })}
            placeholder="例如 rm -rf, sudo, curl"
          />
        </Field>
      </div>
    </>
  );
}

function WebhookBody({ draft: d, set, canManageWebhook, goStage }: ProfileProps) {
  if (!canManageWebhook) {
    return (
      <>
        <Field label="回调 URL">
          <Input aria-label="回调 URL" value="（已隐藏）" disabled />
        </Field>
        <p className="m-0 text-[13px] text-muted-foreground">
          回调地址只有智能体所有者和管理员能看和改。
        </p>
      </>
    );
  }
  return (
    <>
      <Field label="回调 URL（仅所有者和管理员可见）">
        <Input
          aria-label="回调 URL"
          className={inputMono}
          value={d.webhookUrl}
          onChange={(e) => set({ webhookUrl: e.target.value })}
          placeholder="https://your-system/callback"
        />
      </Field>
      <p className="m-0 text-[13px] text-muted-foreground">
        运行到终态（成功、失败、取消）时推送，用账号级签名密钥签名（
        <Link href="/developer/keys" className="underline">
          开发者，签名密钥
        </Link>
        ）。投递记录在
        <button type="button" className="mx-1 underline" onClick={() => goStage("access")}>
          接入
        </button>
        里看。
      </p>
    </>
  );
}
