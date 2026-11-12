"use client";

// 发布阶段:上线清单(A8,由现有 release-status 驱动)、发布、版本列表(快照 / 对比 / 载入草稿 / 回滚与设为发布版)、
// 分享(公开、按账号或组定向分享 A15、遗留授权撤销)、申请上架(A13)、删除智能体。
// 发布的前后端约束不变:评测全过、有差异才能发布;回滚与设为发布版只需确认,不受评测限制。

import { useConfirm } from "@/components/confirm-dialog";
import { notifyAgentCatalogChanged } from "@/components/ide/agent-catalog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { PUBLIC_PRINCIPAL } from "@/lib/modules/access/domain/grants";
import type { SnapshotChange } from "@/lib/modules/agent/domain/snapshot-diff";
import { cn } from "@/lib/utils";
import {
  Check,
  Eye,
  Globe,
  Loader2,
  Lock,
  RefreshCw,
  Store,
  Trash2,
  TriangleAlert,
  User,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type EvalSummary,
  type LaunchTarget,
  type Stage,
  launchChecklist,
  versionEvalText,
} from "./build-model";
import { DiffCounts, DiffList } from "./diff-view";
import {
  type ListingState,
  fetchListingRequest,
  listingView,
  submitListingRequest,
} from "./listing-request";
import { Banner, CodeBlock, Seg, StageTitle, SubHead, Tag, TextButton } from "./ui";
import type { VersionMeta } from "./use-build-data";

interface Grant {
  id: string;
  principalType: "user" | "group" | "*";
  principalId: string;
  permission: "read" | "write";
  label?: string | null;
}

interface Group {
  id: string;
  name: string;
  memberCount?: number;
}

const BUILT_IN = ["default", "agent-architect"];

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function PublishStage({
  agentId,
  agentName,
  ready,
  filled,
  caseCount,
  draftEval,
  versions,
  versionEvals,
  publishedVersion,
  hasUnpublishedChanges,
  changeCount,
  keyCount,
  saving,
  canManage,
  listed,
  beforePublish,
  onPublished,
  onRestored,
  onChanged,
  onRecheck,
  goStage,
  onFix,
}: {
  agentId: string | null;
  agentName: string;
  ready: boolean;
  filled: number;
  caseCount: number;
  draftEval: EvalSummary | null;
  versions: VersionMeta[] | null;
  versionEvals: Record<string, EvalSummary>;
  publishedVersion: number | null;
  hasUnpublishedChanges: boolean;
  changeCount: number | null;
  keyCount: number;
  saving: boolean;
  /** 所有者或管理员:分享、上架、删除 */
  canManage: boolean;
  listed: boolean;
  beforePublish: () => Promise<boolean>;
  onPublished: (version: number) => void;
  onRestored: () => void;
  onChanged: () => void;
  onRecheck: () => void;
  goStage: (s: Stage) => void;
  /** 「去修复」:跳到评测并请设计器修复 */
  onFix: () => void;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [justPublished, setJustPublished] = useState<number | null>(null);
  const [reveal, setReveal] = useState(0);
  const [diff, setDiff] = useState<{
    title: string;
    sub?: string;
    changes: SnapshotChange[];
  } | null>(null);
  const [snapshot, setSnapshot] = useState<{ title: string; body: string } | null>(null);
  const base = agentId ? `/api/agents/${encodeURIComponent(agentId)}` : "";
  const next = (versions?.[0]?.version ?? 0) + 1;

  // 清单逐项出现(重新检查时重来一遍)
  const [round, setRound] = useState(0);
  useEffect(() => {
    void round;
    setReveal(0);
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      setReveal(n);
      if (n >= 5) clearInterval(t);
    }, 180);
    return () => clearInterval(t);
  }, [round]);

  const c = launchChecklist({
    ready,
    filled,
    caseCount,
    draftEval,
    publishedVersion,
    nextVersion: next,
    hasUnpublishedChanges,
    changeCount,
    justPublished,
    keyCount,
    saving,
  });

  async function post(key: string, url: string, body: unknown) {
    setBusy(key);
    try {
      return await fetchJson<{ version?: VersionMeta }>(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!(await beforePublish())) {
      toast.error("档案里还有没保存的修改（或暂停了保存），先处理好再发布");
      return;
    }
    try {
      const r = await post("publish", `${base}/versions`, { note: note.trim() || undefined });
      const v = r.version?.version ?? next;
      toast.success(`已发布 v${v}`);
      setNote("");
      setJustPublished(v);
      notifyAgentCatalogChanged();
      onPublished(v);
    } catch (e) {
      toast.error(`发布失败：${errorText(e)}`);
    }
  }

  async function compare(from: string, to: string, title: string, sub?: string) {
    try {
      const d = await fetchJson<{ changes: SnapshotChange[] }>(
        `${base}/versions/diff?from=${from}&to=${to}`,
      );
      setDiff({ title, sub, changes: d.changes });
    } catch (e) {
      toast.error(`对比失败：${errorText(e)}`);
    }
  }

  async function showSnapshot(v: number) {
    try {
      const d = await fetchJson<{
        version: { config: unknown; name?: string; description?: string };
      }>(`${base}/versions/${v}`);
      setSnapshot({ title: `v${v} 快照`, body: JSON.stringify(d.version, null, 2) });
    } catch (e) {
      toast.error(`读取快照失败：${errorText(e)}`);
    }
  }

  function go(to: LaunchTarget) {
    if (to === "fix") onFix();
    else if (to === "diff" && publishedVersion !== null)
      void compare(String(publishedVersion), "draft", `草稿与 v${publishedVersion} 的差异`);
    else if (to !== "diff") goStage(to);
  }

  if (!agentId) {
    return (
      <div>
        <StageTitle title="上线清单" />
        <Banner>填好名称和提示词、草稿自动建好后就能评测和发布。</Banner>
      </div>
    );
  }

  return (
    <div>
      <StageTitle
        title="上线清单"
        desc={`${c.readyCount}/5 项已就绪。不满足的项就地去处理。`}
        right={
          <TextButton
            onClick={() => {
              onRecheck();
              setRound((r) => r + 1);
            }}
          >
            <RefreshCw />
            重新检查
          </TextButton>
        }
      />
      {justPublished !== null && (
        <div className="mb-[18px] flex items-center gap-4 rounded-2xl border border-[#CFE0D3] bg-[#F3F8F4] px-5 py-[18px] max-md:flex-wrap">
          <span className="grid size-[46px] shrink-0 place-items-center rounded-full bg-success text-white">
            <Check className="size-6" strokeWidth={2.6} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-display text-[22px]">v{justPublished} 已发布</div>
            <div className="text-sm text-muted-foreground">
              调用方和其他使用者从现在起使用 v{justPublished}
              ；进行中的会话不受影响。下一步：签一个只给本智能体用的 Key。
            </div>
          </div>
          <Button onClick={() => goStage("access")}>去接入</Button>
        </div>
      )}
      <div className="max-w-[720px]">
        {c.items.map((it, i) => {
          const shown = i < reveal;
          return (
            <div
              key={it.key}
              className="flex items-start gap-4 border-b border-line-soft px-1 py-4 max-md:gap-3"
            >
              <span
                className={cn(
                  "mt-px grid size-7 shrink-0 place-items-center rounded-full border-[1.5px] border-[#C9C4B8] transition-all",
                  shown && it.ok && "border-success bg-success text-white",
                  shown && !it.ok && "border-[#E3BE7C] bg-warning-soft text-warning-text",
                )}
              >
                {!shown ? (
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                ) : it.ok ? (
                  <Check className="size-[15px]" strokeWidth={2.6} />
                ) : (
                  <TriangleAlert className="size-3.5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className={cn("text-base font-semibold", shown && it.ok && "text-[#2C5C40]")}>
                  {it.title}
                </div>
                <div className="mt-0.5 text-sm text-muted-foreground">{it.detail}</div>
                {it.key === "publish" && justPublished === null && shown && (
                  <div className="mt-2.5">
                    <div className="flex items-start gap-2.5 max-md:flex-col max-md:items-stretch">
                      <div className="min-w-0 flex-1">
                        <Textarea
                          aria-label="版本说明"
                          rows={2}
                          maxLength={512}
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="版本说明（可选，最多 512 字）"
                          className="min-h-16 resize-y"
                        />
                        <div className="mt-1 text-right text-xs text-muted-foreground">
                          {note.length}/512
                        </div>
                      </div>
                      <Button
                        disabled={!c.canPublish || busy !== null}
                        onClick={() => void publish()}
                      >
                        {busy === "publish" && <Loader2 className="animate-spin" />}
                        {busy === "publish" ? "发布中" : `发布为 v${next}`}
                      </Button>
                    </div>
                    {c.publishHint && (
                      <div className="text-[13px] text-muted-foreground">{c.publishHint}</div>
                    )}
                  </div>
                )}
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {shown && !it.ok && it.action && (
                  <Button size="sm" onClick={() => go(it.action?.to ?? "orch")}>
                    {it.action.label}
                  </Button>
                )}
                {shown && it.ok && it.alt && (
                  <Button size="sm" variant="outline" onClick={() => go(it.alt?.to ?? "orch")}>
                    {it.alt.label}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-[26px] mb-2 text-[15px] font-semibold">
        版本（{versions?.length ?? 0}）
      </div>
      <p className="mt-0 mb-1.5 text-[13px] text-muted-foreground">
        {publishedVersion !== null
          ? `已发布后，接口调用和其他使用者用发布版 v${publishedVersion}；调用方可用 version 锁定某一版。`
          : "未发布时，接口调用和其他用户都直接用草稿。"}
        回滚和设为发布版只需确认，不受评测限制，秒级生效。
      </p>
      {versions === null && <p className="text-sm text-muted-foreground">载入中…</p>}
      {versions?.length === 0 && (
        <p className="text-sm text-muted-foreground">还没有版本。发布后在这里出现。</p>
      )}
      {versions?.map((v, i) => {
        const current = v.version === publishedVersion;
        const ev = versionEvals[v.version];
        return (
          <div
            key={v.version}
            className="flex flex-wrap items-center gap-3 border-b border-line-soft px-1 py-3 text-sm"
          >
            <span className="w-9 font-display text-base font-bold">v{v.version}</span>
            {current ? <Tag tone="ok">当前发布版</Tag> : <Tag line>历史</Tag>}
            <Tag line className={ev?.state === "passed" ? "text-success-text" : undefined}>
              <span data-testid="version-eval">{versionEvalText(ev)}</span>
            </Tag>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {v.note || "（无说明）"}
            </span>
            <span className="text-xs text-muted-foreground">{fmtTime(v.createdAt)}</span>
            <div className="flex w-full flex-wrap gap-0.5 pl-12 max-md:pl-0">
              <TextButton onClick={() => void showSnapshot(v.version)}>
                <Eye />
                查看快照
              </TextButton>
              <TextButton
                onClick={() =>
                  void compare(String(v.version), "draft", `v${v.version} 与当前草稿的差异`, v.note)
                }
              >
                对比草稿
              </TextButton>
              <TextButton
                disabled={i === versions.length - 1 || v.version <= 1}
                title={v.version <= 1 ? "这是第一个版本" : undefined}
                onClick={() =>
                  void compare(
                    String(v.version - 1),
                    String(v.version),
                    `v${v.version} 与 v${v.version - 1} 的差异`,
                    v.note,
                  )
                }
              >
                对比上一版
              </TextButton>
              <TextButton
                disabled={busy !== null || saving}
                title={saving ? "草稿正在保存，稍后再载入" : "用这一版的内容覆盖草稿"}
                onClick={() =>
                  confirm.ask({
                    title: `用 v${v.version} 覆盖草稿？`,
                    description: "当前草稿会被这一版的内容替换；已发布的版本不受影响。",
                    confirmLabel: "载入草稿",
                    onConfirm: async () => {
                      try {
                        await post(
                          `restore-${v.version}`,
                          `${base}/versions/${v.version}/restore`,
                          {},
                        );
                        toast.success(`已把 v${v.version} 载入草稿`);
                        onRestored();
                      } catch (e) {
                        toast.error(errorText(e));
                      }
                    },
                  })
                }
              >
                载入草稿
              </TextButton>
              {!current && (
                <TextButton
                  disabled={busy !== null}
                  onClick={() =>
                    confirm.ask({
                      title:
                        publishedVersion !== null && v.version < publishedVersion
                          ? `回滚到 v${v.version}？`
                          : `把 v${v.version} 设为发布版？`,
                      description:
                        "新的接口调用与其他用户的新会话会立即改用这一版；进行中的会话不受影响。不受评测限制。",
                      confirmLabel:
                        publishedVersion !== null && v.version < publishedVersion
                          ? "回滚"
                          : "设为发布版",
                      onConfirm: async () => {
                        try {
                          await post(
                            `activate-${v.version}`,
                            `${base}/versions/${v.version}/activate`,
                            {},
                          );
                          toast.success(`已切换到 v${v.version}`);
                          notifyAgentCatalogChanged();
                          onChanged();
                        } catch (e) {
                          toast.error(errorText(e));
                        }
                      },
                    })
                  }
                >
                  {publishedVersion !== null && v.version < publishedVersion
                    ? "回滚到此版"
                    : "设为发布版"}
                </TextButton>
              )}
            </div>
          </div>
        );
      })}

      <div className="mt-[26px] mb-2 text-[15px] font-semibold">分享与上架</div>
      {canManage ? (
        <SharePanel
          agentId={agentId}
          publishedVersion={publishedVersion}
          listed={listed}
          onDelete={() =>
            confirm.ask({
              title: `删除「${agentName}」？`,
              description:
                "删除后：接口调用、分享立即失效，绑定它的 API Key 也调不通了；历史会话与运行记录保留。此操作不能在界面上撤销。",
              confirmLabel: "删除智能体",
              destructive: true,
              onConfirm: async () => {
                try {
                  await fetchJson(base, { method: "DELETE" });
                  notifyAgentCatalogChanged();
                  toast.success(`已删除「${agentName}」`);
                  // 请求期间已经切到别的智能体:不再把页面带回工作室
                  if (aliveRef.current) router.push("/agents");
                } catch (e) {
                  toast.error(`删除失败：${errorText(e)}`);
                }
              },
            })
          }
          deletable={!BUILT_IN.includes(agentId)}
        />
      ) : (
        <Banner icon={<Lock />}>
          这个智能体不归你管。公开、分享、上架与删除只有所有者能操作。
        </Banner>
      )}

      <Dialog open={diff !== null} onOpenChange={(o) => !o && setDiff(null)}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{diff?.title}</DialogTitle>
            {diff?.sub && <DialogDescription>{diff.sub}</DialogDescription>}
          </DialogHeader>
          {diff && <DiffCounts changes={diff.changes} />}
          {diff && <DiffList changes={diff.changes} />}
          <DialogFooter>
            <Button onClick={() => setDiff(null)}>好的</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={snapshot !== null} onOpenChange={(o) => !o && setSnapshot(null)}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{snapshot?.title}</DialogTitle>
            <DialogDescription>这一版发布时的完整配置，只读。</DialogDescription>
          </DialogHeader>
          <CodeBlock className="max-h-[60dvh] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {snapshot?.body}
          </CodeBlock>
          <DialogFooter>
            <Button onClick={() => setSnapshot(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirm.dialog}
    </div>
  );
}

function SharePanel({
  agentId,
  publishedVersion,
  listed,
  onDelete,
  deletable,
}: {
  agentId: string;
  publishedVersion: number | null;
  listed: boolean;
  onDelete: () => void;
  deletable: boolean;
}) {
  const confirm = useConfirm();
  const base = `/api/agents/${encodeURIComponent(agentId)}`;
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [kind, setKind] = useState<"user" | "group">("user");
  const [who, setWho] = useState("");
  const [perm, setPerm] = useState<"read" | "write">("read");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [listing, setListing] = useState<ListingState>({ kind: "loading" });
  const [listNote, setListNote] = useState("");

  const reload = useCallback(async () => {
    try {
      const d = await fetchJson<{ grants: Grant[] }>(`${base}/share`);
      setGrants(d.grants);
    } catch (e) {
      setGrants([]);
      setMsg(`分享设置加载失败：${errorText(e)}`);
    }
  }, [base]);

  useEffect(() => {
    void reload();
    void fetchJson<{ groups: Group[] }>("/api/groups").then(
      (d) => setGroups(d.groups),
      () => setGroups([]),
    );
    void fetchListingRequest(agentId).then(setListing);
  }, [reload, agentId]);

  const publicGrant = grants?.find(
    (g) => g.principalType === "*" || g.principalId === PUBLIC_PRINCIPAL,
  );
  const targeted = (grants ?? []).filter(
    (g) => g.principalType === "user" || g.principalType === "group",
  );
  const lv = listingView({ state: listing, publishedVersion, listed });

  async function share(target: string, permission: "read" | "write") {
    setBusy(true);
    setMsg("");
    try {
      await fetchJson(`${base}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, permission }),
      });
      await reload();
      return true;
    } catch (e) {
      setMsg(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function revoke(g: Grant, what: string) {
    confirm.ask({
      title: `撤销${what}？`,
      description: "对方将立即失去访问权限。",
      confirmLabel: "撤销",
      destructive: true,
      onConfirm: async () => {
        try {
          await fetchJson(`${base}/share?grantId=${encodeURIComponent(g.id)}`, {
            method: "DELETE",
          });
          await reload();
        } catch (e) {
          setMsg(`撤销失败：${errorText(e)}`);
        }
      },
    });
  }

  return (
    <>
      <div className="mb-2.5 overflow-hidden rounded-xl border border-border">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line-soft px-3 py-2.5 text-sm">
          <Globe className="size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              公开给所有账号 {publicGrant && <Tag tone="ok">已公开</Tag>}
            </div>
            <div className="text-[13px] text-muted-foreground">
              只读：任何登录账号都能使用{publishedVersion !== null ? "发布版" : "草稿"}
              、查看配置。公开不等于上架市场。
            </div>
          </div>
          <Button
            size="sm"
            variant={publicGrant ? "outline" : "default"}
            disabled={busy || grants === null}
            onClick={() =>
              publicGrant ? revoke(publicGrant, "公开") : void share("public", "read")
            }
          >
            {publicGrant ? "取消公开" : "公开"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5 text-sm">
          <Store className="size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">申请上架市场</div>
            <div
              className={cn(
                "text-[13px] text-muted-foreground",
                lv.tone === "bad" && "text-destructive",
                lv.tone === "warn" && "text-warning-text",
                lv.tone === "ok" && "text-success-text",
              )}
            >
              {lv.text}
            </div>
            {lv.canSubmit && (
              <Input
                aria-label="上架申请备注"
                className="mt-1.5 max-w-md"
                value={listNote}
                maxLength={500}
                onChange={(e) => setListNote(e.target.value)}
                placeholder="给审核的管理员留句话（可选）"
              />
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!lv.canSubmit || busy}
            onClick={async () => {
              setBusy(true);
              const r = await submitListingRequest(agentId, listNote).catch((e) => ({
                ok: false as const,
                message: errorText(e),
              }));
              setBusy(false);
              if (r.ok) {
                toast.success("已提交上架申请，等待管理员审核");
                setListNote("");
                setListing({ kind: "ok", request: r.request });
              } else {
                toast.error(r.message);
                void fetchListingRequest(agentId).then(setListing);
              }
            }}
          >
            {lv.button}
          </Button>
        </div>
      </div>

      <SubHead>
        <span>
          定向分享
          <span className="ml-2 font-normal text-muted-foreground">
            分享给某个账号或组，权限只读或可编辑
          </span>
        </span>
      </SubHead>
      <form
        className="mb-2 flex flex-wrap items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const t = who.trim();
          if (!t) return setMsg(kind === "user" ? "填写对方的账号邮箱" : "选择一个组");
          const ok = await share(kind === "group" ? `group:${t}` : t, perm);
          if (ok) {
            setWho("");
            toast.success("已分享");
          }
        }}
      >
        <Seg
          ariaLabel="分享对象类型"
          options={[
            ["user", "账号"],
            ["group", "组"],
          ]}
          value={kind}
          onChange={(k) => {
            setKind(k);
            setWho("");
          }}
        />
        {kind === "user" ? (
          <Input
            aria-label="分享对象"
            className="min-w-48 flex-1"
            value={who}
            onChange={(e) => setWho(e.target.value)}
            placeholder="账号邮箱，如 wanglei@example.com"
          />
        ) : (
          <NativeSelect
            aria-label="选择组"
            className="min-w-48 flex-1"
            value={who}
            onChange={(e) => setWho(e.target.value)}
          >
            <option value="">{groups.length ? "选择组" : "还没有你建的组"}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
                {g.memberCount !== undefined ? `，${g.memberCount} 人` : ""}
              </option>
            ))}
          </NativeSelect>
        )}
        <NativeSelect
          aria-label="权限"
          className="w-[150px]"
          value={perm}
          onChange={(e) => setPerm(e.target.value as "read" | "write")}
        >
          <option value="read">只读</option>
          <option value="write">可编辑</option>
        </NativeSelect>
        <Button type="submit" size="sm" disabled={busy}>
          分享
        </Button>
      </form>
      {msg && <p className="mt-0 mb-2 text-[13px] text-destructive">{msg}</p>}
      <div className="overflow-hidden rounded-xl border border-border">
        {grants === null ? (
          <div className="px-3 py-2.5 text-sm text-muted-foreground">载入中…</div>
        ) : targeted.length === 0 ? (
          <div className="px-3 py-2.5 text-sm text-muted-foreground">还没有定向分享</div>
        ) : (
          targeted.map((g) => {
            const name = g.label ?? g.principalId;
            const what =
              g.principalType === "group" ? `对组「${name}」的分享` : `对 ${name} 的分享`;
            return (
              <div
                key={g.id}
                className="flex items-center gap-2.5 border-b border-line-soft px-3 py-2.5 text-sm last:border-0"
              >
                {g.principalType === "group" ? (
                  <Users className="size-4" />
                ) : (
                  <User className="size-4" />
                )}
                <span className="min-w-0 truncate">
                  {g.principalType === "group" ? `${name}（组）` : name}
                </span>
                <Tag>{g.permission === "write" ? "可编辑" : "只读"}</Tag>
                <TextButton className="ml-auto" disabled={busy} onClick={() => revoke(g, what)}>
                  撤销
                </TextButton>
              </div>
            );
          })
        )}
      </div>

      {deletable && (
        <div className="mt-[22px] rounded-2xl border border-[#EBC5BB] bg-[#FFFCFB] px-[18px] py-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <b className="text-destructive">删除智能体</b>
              <div className="text-sm text-muted-foreground">
                接口调用、分享、绑定的 Key 都会失效；历史运行与计费记录保留；界面上无法撤销。
              </div>
            </div>
            <Button size="sm" variant="destructive" onClick={onDelete}>
              <Trash2 />
              删除智能体
            </Button>
          </div>
        </div>
      )}
      {confirm.dialog}
    </>
  );
}
