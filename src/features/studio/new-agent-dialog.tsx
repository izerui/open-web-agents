"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cloneDoneText } from "@/features/market/market-actions";
import { type AvatarStyle, formatAvatarIcon } from "@/lib/agent-avatar";
import { notifyAgentCatalogChanged } from "@/lib/agent-catalog";
import { errorText, fetchJson } from "@/lib/fetch-json";
import type { AgentTemplate } from "@/lib/modules/agent/templates";
import { MARKET_CATEGORIES, type MarketAgent } from "@/lib/modules/market/domain/catalog";
import { agentHref } from "@/lib/nav/routes";
import { cn } from "@/lib/utils";
import { LayoutGrid, Loader2, Plus, Search, Sparkles, Store } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cloneAgent } from "./readonly-drawer";
import { type NewMode, blankCreateBody, validateNewAgentId } from "./studio-model";

const MODES: readonly { key: NewMode; icon: typeof Plus; title: string; desc: string }[] = [
  {
    key: "ai",
    icon: Sparkles,
    title: "用智能体设计器创建",
    desc: "说清规则，设计器帮你配好模型、工具、知识和评测",
  },
  { key: "blank", icon: Plus, title: "空白创建", desc: "自己填名称和提示词" },
  { key: "clone", icon: Store, title: "从市场克隆", desc: "复制一个上架智能体来改" },
  { key: "tpl", icon: LayoutGrid, title: "模板库", desc: "按场景挑一个起点" },
];

const EXAMPLES = [
  "做一个审核报销单的助手，超过 5000 元提醒我",
  "每周汇总竞品官网和招聘动态",
  "把客服工单按紧急程度分类",
];

/** 空白创建可选的头像(A12),写进 icon 字段 */
const AVATARS: readonly AvatarStyle[] = [
  { color: "#F2B49B", eyes: "pill" },
  { color: "#C8C2E8", eyes: "round" },
  { color: "#E7D2AA", eyes: "side" },
  { color: "#CADBCF", eyes: "dot" },
  { color: "#B9D0E8", eyes: "round" },
  { color: "#F4B3C3", eyes: "pill" },
  { color: "#B8DCD6", eyes: "side" },
  { color: "#F0D58C", eyes: "dot" },
];

const OK_TEXT: Record<NewMode, string> = {
  ai: "用设计器创建",
  blank: "创建并进入编排",
  clone: "克隆并进入编排",
  tpl: "用模板创建",
};

const categoryName = (id: string) => MARKET_CATEGORIES.find((c) => c.id === id)?.name ?? id;

function Field({
  label,
  htmlFor,
  required,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
        {required && <span className="text-destructive">*</span>}
      </label>
      {children}
      {hint && <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** 卡片样式的单选项:真正的 radio(读屏、方向键都按原生行为),外观是一张可点的卡 */
function RadioCard({
  name,
  checked,
  onSelect,
  className,
  children,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center border border-border bg-card text-left hover:border-[#BDB8AC] has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-[#D9D5CB]",
        checked && "border-foreground shadow-[inset_0_0_0_1px_var(--color-foreground)]",
        className,
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="sr-only" />
      {children}
    </label>
  );
}

/**
 * 新建智能体弹层:智能体设计器(默认)/ 空白 / 从市场克隆 / 模板库。
 * 每种方式确认后都立刻建好(设计器是建好设计会话),然后进入对应页面。
 */
export function NewAgentDialog({
  open,
  onOpenChangeAction,
  initialMode = "ai",
  initialDesc = "",
  takenIds,
}: {
  open: boolean;
  onOpenChangeAction: (open: boolean) => void;
  initialMode?: NewMode;
  initialDesc?: string;
  /** 已知被占用的 ID(列表里看得到的);看不到的由接口兜底返回 409 */
  takenIds: readonly string[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<NewMode>(initialMode);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  const [desc, setDesc] = useState(initialDesc);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [avatar, setAvatar] = useState(0);

  const [market, setMarket] = useState<MarketAgent[] | null>(null);
  const [marketError, setMarketError] = useState("");
  const [q, setQ] = useState("");
  const [cloneSel, setCloneSel] = useState("");

  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState("");
  const [tpl, setTpl] = useState("");
  const [tplName, setTplName] = useState("");

  // 打开时回到入口给的方式与描述(从探索页带着 desc 过来时直接预填)
  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setDesc(initialDesc);
    setError("");
  }, [open, initialMode, initialDesc]);

  useEffect(() => {
    if (!open || mode !== "clone" || market) return;
    let alive = true;
    setMarketError("");
    fetchJson<{ items: MarketAgent[] }>("/api/market")
      .then((d) => {
        if (!alive) return;
        // 只列已上架的:克隆接口只接受上架智能体(管理员的候选列表里还有未上架的)
        const items = d.items.filter((m) => m.marketListed);
        setMarket(items);
        setCloneSel((s) => s || items[0]?.id || "");
      })
      .catch((e: unknown) => alive && setMarketError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [open, mode, market]);

  useEffect(() => {
    if (!open || mode !== "tpl" || templates) return;
    let alive = true;
    setTemplatesError("");
    fetchJson<{ templates: AgentTemplate[] }>("/api/agents/templates")
      .then((d) => {
        if (!alive) return;
        setTemplates(d.templates);
        const first = d.templates[0];
        if (first) {
          setTpl((t) => t || first.id);
          setTplName((n) => n || first.name);
        }
      })
      .catch((e: unknown) => alive && setTemplatesError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [open, mode, templates]);

  function switchMode(next: NewMode) {
    setMode(next);
    setError("");
  }

  async function run(task: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setError(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function confirm() {
    setError("");
    if (mode === "ai") {
      const text = desc.trim();
      if (!text) return setError("先描述一下你想要的智能体");
      void run(async () => {
        const d = await fetchJson<{ sessionId: string }>("/api/agents/design", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        router.push(
          `${agentHref({ isNew: true })}?designer=${encodeURIComponent(d.sessionId)}&desc=${encodeURIComponent(text)}`,
        );
      });
      return;
    }
    if (mode === "blank") {
      if (!name.trim()) return setError("名称不能为空");
      const idError = validateNewAgentId(id, takenIds);
      if (idError) return setError(idError);
      void run(async () => {
        const body = blankCreateBody({
          name,
          id,
          description,
          icon: formatAvatarIcon(AVATARS[avatar] ?? { color: "#F2B49B", eyes: "pill" }),
        });
        const res = await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as {
          agent?: { id: string; name: string };
          error?: string;
          code?: string;
        };
        if (res.status === 409) throw new Error("ID 已被占用");
        if (!res.ok || !data.agent) throw new Error(data.error ?? `创建失败（HTTP ${res.status}）`);
        notifyAgentCatalogChanged();
        toast.success(`已创建「${data.agent.name}」`);
        router.push(agentHref({ id: data.agent.id }));
      });
      return;
    }
    if (mode === "clone") {
      if (!cloneSel) return setError("先选一个要克隆的智能体");
      void run(async () => {
        const copy = await cloneAgent(cloneSel);
        toast.success(cloneDoneText(market?.find((m) => m.id === cloneSel)?.name, copy.name));
        router.push(agentHref({ id: copy.id }));
      });
      return;
    }
    if (!tpl) return setError("先选一个模板");
    void run(async () => {
      const d = await fetchJson<{ agent: { id: string; name: string } }>(
        "/api/agents/from-template",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ templateId: tpl, name: tplName }),
        },
      );
      notifyAgentCatalogChanged();
      toast.success(`已用模板创建「${d.agent.name}」`);
      router.push(agentHref({ id: d.agent.id }));
    });
  }

  const query = q.trim().toLowerCase();
  const marketShown = (market ?? []).filter(
    (m) =>
      !query ||
      `${m.name}\n${m.description ?? ""}\n${categoryName(m.category)}`
        .toLowerCase()
        .includes(query),
  );
  const template = templates?.find((t) => t.id === tpl);

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChangeAction(v)}>
      <DialogContent
        className="max-h-[92dvh] gap-0 overflow-y-auto p-5 sm:max-w-[720px] sm:p-7"
        onOpenAutoFocus={(e) => {
          // 默认会聚焦第一张方式卡片,看着像多选中了一张;直接把光标放进要填的输入框
          const field = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
            "textarea, input:not([type=radio])",
          );
          if (field) {
            e.preventDefault();
            field.focus();
          }
        }}
      >
        <DialogTitle>新建智能体</DialogTitle>
        <DialogDescription className="mt-1">建好就是一份草稿，直接进入编排。</DialogDescription>

        <fieldset className="mt-4 mb-5 grid grid-cols-2 gap-2 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <legend className="sr-only">新建方式</legend>
          {MODES.map((m) => {
            const on = mode === m.key;
            return (
              <RadioCard
                key={m.key}
                name="nw-mode"
                checked={on}
                onSelect={() => switchMode(m.key)}
                className={cn(
                  "min-h-[84px] flex-col items-stretch gap-1 rounded-[14px] p-3",
                  m.key === "ai" && !on && "border-[#E2DED3] bg-[#F4F2EC]",
                  m.key === "ai" && on && "bg-[#F4F2EC]",
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <m.icon className="size-4" aria-hidden="true" />
                  {m.title}
                </span>
                <span className="text-xs leading-snug text-muted-foreground">{m.desc}</span>
              </RadioCard>
            );
          })}
        </fieldset>

        <div className="flex flex-col gap-4">
          {mode === "ai" && (
            <>
              <Field
                label="描述你想要的智能体"
                htmlFor="nw-desc"
                required
                hint="说清楚它做什么、要遵守哪些规则、交付什么。智能体设计器会追问细节，配好模型、工具、知识和评测用例，生成草稿后进入编排，之后随时能改。"
              >
                <Textarea
                  id="nw-desc"
                  rows={5}
                  className="min-h-[130px]"
                  value={desc}
                  onChange={(e) => {
                    setDesc(e.target.value);
                    setError("");
                  }}
                  placeholder="比如：做一个审核报销单的助手，读发票和报销单，超过 5000 元提醒部门负责人审批"
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setDesc(t);
                      setError("");
                    }}
                    className="min-h-9 rounded-[10px] border border-border bg-[#FAF9F6] px-3 text-left text-sm hover:border-[#BDB8AC] max-md:min-h-11"
                  >
                    {t}
                  </button>
                ))}
              </div>
            </>
          )}

          {mode === "blank" && (
            <>
              <Field label="名称" htmlFor="nw-name" required>
                <Input
                  id="nw-name"
                  maxLength={60}
                  value={name}
                  placeholder="比如：差旅报销初审"
                  onChange={(e) => {
                    setName(e.target.value);
                    setError("");
                  }}
                />
              </Field>
              <Field
                label="ID"
                htmlFor="nw-id"
                hint="只能用小写字母、数字和短横线，创建后不能改；API 地址里会用到它。"
              >
                <Input
                  id="nw-id"
                  maxLength={36}
                  className="font-mono"
                  value={id}
                  placeholder="留空自动生成"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setId(e.target.value);
                    setError("");
                  }}
                />
              </Field>
              <Field label="描述" htmlFor="nw-d">
                <Input
                  id="nw-d"
                  maxLength={200}
                  value={description}
                  placeholder="一句话说明它做什么"
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-sm font-medium">头像</legend>
                <div className="flex flex-wrap gap-2">
                  {AVATARS.map((s, i) => (
                    <button
                      key={formatAvatarIcon(s)}
                      type="button"
                      aria-pressed={avatar === i}
                      aria-label={`头像 ${i + 1}`}
                      onClick={() => setAvatar(i)}
                      className={cn(
                        "grid size-11 place-items-center rounded-full border-2 border-transparent outline-none focus-visible:ring-[3px] focus-visible:ring-[#D9D5CB]",
                        avatar === i && "border-foreground",
                      )}
                    >
                      <AgentAvatar id={`preset-${i}`} icon={formatAvatarIcon(s)} size={36} />
                    </button>
                  ))}
                </div>
              </fieldset>
            </>
          )}

          {mode === "clone" && (
            <>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="搜索市场智能体"
                  aria-label="搜索市场智能体"
                  className="rounded-full pl-10"
                />
              </div>
              <fieldset className="max-h-[290px] overflow-y-auto rounded-xl border border-border">
                <legend className="sr-only">选择要克隆的智能体</legend>
                {marketError ? (
                  <div className="flex flex-col items-center gap-3 p-8 text-sm text-muted-foreground">
                    市场列表加载失败：{marketError}
                    <Button size="sm" variant="outline" onClick={() => setMarket(null)}>
                      重试
                    </Button>
                  </div>
                ) : !market ? (
                  <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    正在加载市场…
                  </div>
                ) : marketShown.length === 0 ? (
                  <p className="p-8 text-center text-sm text-muted-foreground">
                    {query ? `没有匹配「${q.trim()}」的上架智能体` : "市场里还没有上架的智能体"}
                  </p>
                ) : (
                  marketShown.map((m) => {
                    const on = cloneSel === m.id;
                    return (
                      <label
                        key={m.id}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-3 border-b border-line-soft px-3 py-2.5 text-left last:border-0 hover:bg-[#FAF9F6] has-[:focus-visible]:bg-[#F6F5F1] has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-[#9C978B]",
                          on && "bg-[#F6F5F1]",
                        )}
                      >
                        <input
                          type="radio"
                          name="nw-clone"
                          checked={on}
                          onChange={() => setCloneSel(m.id)}
                          className="sr-only"
                        />
                        <AgentAvatar id={m.id} icon={m.icon} size={36} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">
                            {m.name}{" "}
                            {m.publishedVersion ? (
                              <span className="font-normal text-muted-foreground">
                                v{m.publishedVersion}
                              </span>
                            ) : null}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {[m.author, categoryName(m.category), m.description]
                              .filter(Boolean)
                              .join("，")}
                          </span>
                        </span>
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-4 shrink-0 rounded-full border-[1.5px] border-[#B5B0A4]",
                            on && "border-[5px] border-foreground",
                          )}
                        />
                      </label>
                    );
                  })
                )}
              </fieldset>
              <p className="text-xs text-muted-foreground">
                克隆的是发布版，提示词、能力、契约和知识一并复制，ID
                由系统新生成；密钥类变量不复制，要重新填写；原作者之后的更新不会同步过来。
              </p>
            </>
          )}

          {mode === "tpl" &&
            (templatesError ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-border p-8 text-sm text-muted-foreground">
                模板加载失败：{templatesError}
                <Button size="sm" variant="outline" onClick={() => setTemplates(null)}>
                  重试
                </Button>
              </div>
            ) : !templates ? (
              <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                正在加载模板…
              </div>
            ) : (
              <>
                <fieldset className="grid gap-2 sm:grid-cols-2">
                  <legend className="sr-only">选择模板</legend>
                  {templates.map((t) => {
                    const on = tpl === t.id;
                    return (
                      <RadioCard
                        key={t.id}
                        name="nw-tpl"
                        checked={on}
                        onSelect={() => {
                          // 名称没改过就跟着换成新模板的名字
                          if (!tplName.trim() || tplName === template?.name) setTplName(t.name);
                          setTpl(t.id);
                        }}
                        className="gap-2.5 rounded-xl px-3 py-2.5"
                      >
                        <AgentAvatar id={t.id} icon={t.icon} size={32} />
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold">
                            {t.name}{" "}
                            <span className="text-xs font-normal text-muted-foreground">
                              {t.category}
                            </span>
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {t.description}
                          </span>
                        </span>
                      </RadioCard>
                    );
                  })}
                </fieldset>
                {template && <p className="mt-1 text-[13px] font-semibold">将预填</p>}
                {template && (
                  <div className="grid gap-3 md:grid-cols-[200px_minmax(0,1fr)]">
                    <Field label="名称" htmlFor="nw-tn">
                      <Input
                        id="nw-tn"
                        maxLength={60}
                        value={tplName}
                        onChange={(e) => setTplName(e.target.value)}
                      />
                    </Field>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <span className="text-sm font-medium">提示词开头</span>
                      <pre className="max-h-32 overflow-hidden rounded-[10px] border border-border bg-[#FAF9F6] px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[#3C3A35]">
                        {template.systemPrompt.split("\n").slice(0, 6).join("\n")}
                      </pre>
                    </div>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  模板只是起点：进入编排后可以改提示词、加知识和能力。
                </p>
              </>
            ))}

          <p aria-live="assertive" className="min-h-5 text-sm text-destructive">
            {error}
          </p>
        </div>

        <DialogFooter className="mt-2 flex-row justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChangeAction(false)}
            className="max-md:h-11"
          >
            取消
          </Button>
          <Button disabled={busy} onClick={confirm} className="max-md:h-11">
            {busy ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : mode === "ai" ? (
              <Sparkles aria-hidden="true" />
            ) : null}
            {busy ? "正在创建…" : OK_TEXT[mode]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
