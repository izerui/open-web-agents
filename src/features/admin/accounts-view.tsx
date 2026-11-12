"use client";

import { useConfirm } from "@/components/confirm-dialog";
import { LoadError } from "@/components/load-error";
import { OneTimeSecretDialog } from "@/components/one-time-secret-dialog";
import { Badge } from "@/components/ui/badge";
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
import { Spinner } from "@/components/ui/spinner";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";
import { formatCredits, parseCredits } from "@/lib/modules/capabilities/domain/catalog";
import { peekMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  Coins,
  Lock,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AdminDrawer,
  AdminPage,
  AdminTabs,
  DrawerSection,
  EmptyState,
  Initial,
  Segmented,
  Stat,
  TD,
  TH,
  TableCard,
  useTabParam,
} from "./admin-ui";
import { GroupsPanel } from "./groups-panel";

interface Account {
  id: string;
  email: string;
  role: "admin" | "user";
  disabled: boolean;
  createdAt: number;
  agentCount: number;
  /** 本月已用（微积分；实扣 + 欠额 + 在途冻结） */
  monthUsedMicroCredits: string;
  monthlyLimitMicroCredits: string | null;
  /** 升级遗留的美元上限（微美元），待按积分重新设置 */
  legacyLimitMicroUsd: number | null;
}

const ROLE_FILTERS = [
  { value: "all", label: "全部" },
  { value: "admin", label: "管理员" },
  { value: "user", label: "普通账号" },
] as const;
type RoleFilter = (typeof ROLE_FILTERS)[number]["value"];

const TABS = ["accounts", "groups"] as const;
type Tab = (typeof TABS)[number];

function dateText(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isOver(a: Account): boolean {
  return (
    a.monthlyLimitMicroCredits !== null &&
    BigInt(a.monthUsedMicroCredits) >= BigInt(a.monthlyLimitMicroCredits)
  );
}

/**
 * 平台管理 · 账号（原型 admin-accounts.html）。
 *
 * 【为什么这个页面必须存在】role 只在注册时定死（第一个注册者是 admin），
 * 代码里原本没有任何接口能改它 —— 加个管理员、停用一个滥用的账号，
 * 都只能连数据库跑 SQL。一个要交给运营的平台不能是这样。
 *
 * 第二个页签「用户组」（A15）：所有者可以把智能体定向分享给整个组。
 */
export function AccountsView() {
  const [tab, setTab] = useTabParam<Tab>(TABS, "accounts");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [groupCreating, setGroupCreating] = useState(false);
  const [groupCount, setGroupCount] = useState<number | null>(null);
  /** 刚生成的一次性密码（建号或重置），只展示这一次。 */
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchJson<{ accounts?: Account[] }>("/api/admin/accounts");
      setAccounts(d.accounts ?? []);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totalUsed = accounts.reduce((s, a) => s + BigInt(a.monthUsedMicroCredits), 0n);
  const activeCount = accounts.filter((a) => !a.disabled).length;

  return (
    <AdminPage
      title="账号"
      subtitle={
        tab === "accounts"
          ? loading && accounts.length === 0
            ? "正在读取账号…"
            : `${accounts.length} 个账号，${activeCount} 个启用中，本月消耗 ${creditsAmount(totalUsed)} 积分`
          : `${groupCount === null ? "" : `${groupCount} 个用户组，`}所有者可以把智能体定向分享给整个组（只读或可编辑）`
      }
      actions={
        tab === "accounts" ? (
          <>
            <Button variant="outline" disabled={loading} onClick={() => void load()}>
              <RefreshCw className={cn(loading && "animate-spin")} />
              刷新
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus />
              创建账号
            </Button>
          </>
        ) : (
          <Button onClick={() => setGroupCreating(true)}>
            <Plus />
            新建组
          </Button>
        )
      }
      tabs={
        <AdminTabs
          label="账号与用户组"
          value={tab}
          onChange={setTab}
          items={[
            { value: "accounts", label: "账号" },
            { value: "groups", label: "用户组" },
          ]}
        />
      }
    >
      <OneTimeSecretDialog
        title={secret?.title ?? ""}
        description="这是一次性的密码，关闭后无法再次查看。请当面或私信转交给账号使用者，并提醒其登录后在「账号安全」里修改。"
        secret={secret?.value ?? null}
        onClose={() => setSecret(null)}
      />
      {tab === "accounts" ? (
        <AccountsPanel
          accounts={accounts}
          loading={loading}
          error={error}
          reload={load}
          onSecret={setSecret}
        />
      ) : (
        <GroupsPanel
          creating={groupCreating}
          onCreatingChange={setGroupCreating}
          onCount={setGroupCount}
        />
      )}
      {creating && (
        <CreateAccountDialog
          onClose={() => setCreating(false)}
          onCreated={async (email, password) => {
            setCreating(false);
            setSecret({ title: `已创建 ${email}`, value: password });
            await load();
          }}
        />
      )}
    </AdminPage>
  );
}

function AccountsPanel({
  accounts,
  loading,
  error,
  reload,
  onSecret,
}: {
  accounts: Account[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  onSecret: (s: { title: string; value: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [quotaDraft, setQuotaDraft] = useState<Record<string, string>>({});
  const confirm = useConfirm();
  const selfId = peekMe()?.user?.id;

  /**
   * 返回是否成功。曾经没有 catch（网络错误成了未处理的 rejection）、失败也不告诉调用方，
   * 于是保存额度失败后草稿照样被清空，刚填的数字就丢了。
   */
  async function patch(
    id: string,
    body: Record<string, unknown>,
    okMsg: string,
  ): Promise<{ tempPassword?: string } | null> {
    setBusy(id);
    try {
      const d = await fetchJson<{ tempPassword?: string }>("/api/admin/accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      toast.success(okMsg);
      await reload();
      return d;
    } catch (e) {
      // 服务端的拒绝理由写得很具体（如"这是最后一位管理员"），原样呈现
      toast.error(errorText(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function saveQuota(a: Account, raw: string): Promise<string | null> {
    // 清空 = 取消限额，和"填 0"是两回事（0 意味着一个积分都不许花）
    if (raw !== "") {
      try {
        parseCredits(raw);
      } catch {
        return "上限要填非负积分数（最多六位小数），或留空表示不限";
      }
    }
    const ok = await patch(
      a.id,
      { monthlyLimitCredits: raw === "" ? null : raw },
      raw === "" ? "已取消该账号的月度上限" : `月度上限已设为 ${raw} 积分`,
    );
    if (!ok) return null;
    setQuotaDraft((m) => {
      const next = { ...m };
      delete next[a.id];
      return next;
    });
    return null;
  }

  const needle = query.trim().toLocaleLowerCase();
  const shown = accounts.filter(
    (a) =>
      (!needle || a.email.toLocaleLowerCase().includes(needle)) &&
      (roleFilter === "all" || a.role === roleFilter),
  );
  const selected = accounts.find((a) => a.id === selectedId) ?? null;

  return (
    <>
      {confirm.dialog}
      <div className="mb-3.5 flex flex-wrap items-center gap-3">
        <label className="relative w-[300px] max-w-full">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按邮箱搜索"
            aria-label="按邮箱搜索"
          />
        </label>
        <Segmented
          label="按角色筛选"
          items={ROLE_FILTERS}
          value={roleFilter}
          onChange={setRoleFilter}
        />
        <span className="ml-auto text-xs text-muted-foreground">
          显示 {shown.length} 个，共 {accounts.length} 个
        </span>
      </div>

      <TableCard>
        {error ? (
          <LoadError what="账号列表" message={error} onRetryAction={() => void reload()} />
        ) : loading && accounts.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            正在加载账号…
          </div>
        ) : accounts.length === 0 ? (
          <EmptyState title="还没有任何账号">点右上角「创建账号」建第一个。</EmptyState>
        ) : (
          <>
            {/*
              【为什么是表格】改造前每个账号一张卡片，几百个账号一屏只看得到几个；
              运营要做的是"扫一遍、挑出异常的那几个",这需要一行一个、列对齐。
              改额度、改角色、停用这些写操作在右侧详情里。
            */}
            <table className="w-full min-w-[860px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className={TH}>邮箱</th>
                  <th className={TH}>角色</th>
                  <th className={TH}>注册日期</th>
                  <th className={TH}>智能体</th>
                  <th className={TH}>本月消耗</th>
                  <th className={TH}>月度上限</th>
                  <th className={TH}>状态</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  const active = a.id === selectedId;
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: 整行可点只是鼠标的便利,键盘用行内的按钮或链接
                    <tr
                      key={a.id}
                      onClick={() => setSelectedId(active ? null : a.id)}
                      className={cn(
                        "cursor-pointer hover:bg-[#FAF9F6]",
                        active && "bg-[#F4F2EC] hover:bg-[#F4F2EC]",
                        a.disabled && "text-muted-foreground",
                      )}
                    >
                      <td className={TD}>
                        <button
                          type="button"
                          aria-pressed={active}
                          aria-label={`查看 ${a.email} 的详情`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(active ? null : a.id);
                          }}
                          className="flex min-h-7 min-w-0 items-center gap-2 text-left outline-none focus-visible:underline"
                        >
                          <Initial text={a.email} />
                          <span className="break-all">{a.email}</span>
                          {a.id === selfId && <Badge variant="outline">你自己</Badge>}
                          {a.disabled && <Badge>已停用</Badge>}
                        </button>
                      </td>
                      <td className={TD}>
                        {a.role === "admin" ? <Badge variant="dark">管理员</Badge> : "普通账号"}
                      </td>
                      <td className={cn(TD, "whitespace-nowrap text-muted-foreground")}>
                        {dateText(a.createdAt)}
                      </td>
                      <td className={TD}>{a.agentCount}</td>
                      <td
                        className={cn(
                          TD,
                          "whitespace-nowrap",
                          isOver(a) && "font-medium text-warning-text",
                        )}
                      >
                        {creditsAmount(a.monthUsedMicroCredits)} 积分
                      </td>
                      <td className={cn(TD, "whitespace-nowrap")}>
                        <LimitCell a={a} />
                      </td>
                      <td className={TD}>
                        {a.disabled ? <Badge>已停用</Badge> : <Badge variant="success">启用</Badge>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length === 0 && (
              <EmptyState
                title="没有匹配的账号"
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setQuery("");
                      setRoleFilter("all");
                    }}
                  >
                    清除筛选
                  </Button>
                }
              >
                换个邮箱关键词，或切回「全部」角色。
              </EmptyState>
            )}
          </>
        )}
      </TableCard>

      {selected && (
        <AccountDrawer
          key={selected.id}
          account={selected}
          isSelf={selected.id === selfId}
          busy={busy === selected.id}
          quota={
            quotaDraft[selected.id] ??
            (selected.monthlyLimitMicroCredits === null
              ? ""
              : formatCredits(selected.monthlyLimitMicroCredits))
          }
          onQuotaChange={(v) => setQuotaDraft((m) => ({ ...m, [selected.id]: v }))}
          onSaveQuota={(raw) => saveQuota(selected, raw)}
          onClose={() => setSelectedId(null)}
          onToggleRole={() => {
            const toAdmin = selected.role !== "admin";
            confirm.ask({
              title: toAdmin ? "设为管理员?" : "取消管理员?",
              description: toAdmin
                ? `${selected.email} 将能进入平台管理，操作所有账号、模型、计费和全部智能体（但仍看不到别人的会话）。`
                : `${selected.email} 将失去平台管理入口，只保留自己名下资源的权限。`,
              confirmLabel: toAdmin ? "设为管理员" : "取消管理员",
              destructive: !toAdmin,
              onConfirm: async () => {
                await patch(
                  selected.id,
                  { role: toAdmin ? "admin" : "user" },
                  toAdmin ? "已设为管理员" : "已取消管理员",
                );
              },
            });
          }}
          onResetPassword={() =>
            confirm.ask({
              title: `重置 ${selected.email} 的密码?`,
              description: "旧密码立即失效，系统会生成一个一次性的新密码供你转交。",
              confirmLabel: "生成一次性密码",
              onConfirm: async () => {
                const d = await patch(selected.id, { resetPassword: true }, "密码已重置");
                if (d?.tempPassword) {
                  onSecret({ title: `${selected.email} 的新密码`, value: d.tempPassword });
                }
              },
            })
          }
          onToggleDisabled={() =>
            confirm.ask({
              title: `${selected.disabled ? "恢复" : "停用"} ${selected.email}?`,
              description: selected.disabled
                ? "恢复后可以重新登录。原有 API Key 保持停用，需要本人重新签发。"
                : "该账号会被立即登出，名下全部 API Key 同时停用。之后可以随时恢复。",
              confirmLabel: selected.disabled ? "恢复账号" : "停用账号",
              destructive: !selected.disabled,
              onConfirm: async () => {
                await patch(
                  selected.id,
                  { disabled: !selected.disabled },
                  selected.disabled
                    ? "已恢复该账号，提醒本人重新签发 Key"
                    : "已停用，已登出并停用 Key",
                );
              },
            })
          }
        />
      )}
    </>
  );
}

function LimitCell({ a }: { a: Account }) {
  if (a.legacyLimitMicroUsd !== null) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-warning-text">
        <AlertTriangle className="size-3.5" />
        旧上限 ${(a.legacyLimitMicroUsd / 1_000_000).toFixed(2)},需按积分重设
      </span>
    );
  }
  if (a.monthlyLimitMicroCredits === null)
    return <span className="text-muted-foreground">不限</span>;
  if (a.monthlyLimitMicroCredits === "0") return <Badge variant="destructive">禁止消费</Badge>;
  return <>{creditsAmount(a.monthlyLimitMicroCredits)} 积分</>;
}

/**
 * 选中账号的详情与写操作。
 * 【为什么停用单独沉到下面】改造前"停用"和"重置密码"并排挨着，手一滑就点错。
 * 危险操作单独一段、红色描边，和日常操作隔开。
 */
function AccountDrawer({
  account: a,
  isSelf,
  busy,
  quota,
  onQuotaChange,
  onSaveQuota,
  onClose,
  onToggleRole,
  onResetPassword,
  onToggleDisabled,
}: {
  account: Account;
  isSelf: boolean;
  busy: boolean;
  quota: string;
  onQuotaChange: (v: string) => void;
  onSaveQuota: (raw: string) => Promise<string | null>;
  onClose: () => void;
  onToggleRole: () => void;
  onResetPassword: () => void;
  onToggleDisabled: () => void;
}) {
  const [quotaError, setQuotaError] = useState("");
  const over = isOver(a);
  const roleText = a.role === "admin" ? "管理员" : "普通账号";
  const selfNote = (t: string) =>
    isSelf ? <p className="mt-2 text-xs text-muted-foreground">{t}</p> : null;
  return (
    <AdminDrawer
      label={`${a.email} 的详情`}
      testId="account-detail"
      onClose={onClose}
      head={
        <div className="flex items-center gap-3">
          <Initial text={a.email} size={44} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-base font-semibold">
              <span className="break-all">{a.email}</span>
              {isSelf && <Badge variant="outline">你自己</Badge>}
            </div>
            <div className="text-xs text-muted-foreground">
              {roleText},注册于 {dateText(a.createdAt)}
              {a.disabled ? ",已停用" : ""}
            </div>
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Stat label="智能体" value={a.agentCount} />
        <Stat
          label="本月消耗（积分）"
          value={creditsAmount(a.monthUsedMicroCredits)}
          hint={over ? "已达月度上限" : undefined}
          className={cn(over && "border-warning/50")}
        />
      </div>

      <DrawerSection
        title="月度上限（积分）"
        desc="留空表示不限；填 0 表示禁止消费；本月消耗超过上限后，新运行会被拒绝。"
      >
        {a.legacyLimitMicroUsd !== null && (
          <p
            data-testid="legacy-limit"
            className="mb-2.5 flex gap-2 rounded-xl bg-warning-soft px-3 py-2.5 text-[13px] text-warning-text"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            旧上限按美元设置（${(a.legacyLimitMicroUsd / 1_000_000).toFixed(2)}
            ），还没按积分重设。重设（或留空保存为不限）前该账号不能发起运行。
          </p>
        )}
        <form
          className="flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setQuotaError((await onSaveQuota(quota.trim())) ?? "");
          }}
        >
          <Input
            className="flex-1"
            inputMode="decimal"
            aria-label="月度上限（积分）"
            placeholder="不限"
            value={quota}
            onChange={(e) => {
              setQuotaError("");
              onQuotaChange(e.target.value);
            }}
          />
          <Button type="submit" size="sm" disabled={busy}>
            保存
          </Button>
        </form>
        {quotaError && <p className="mt-1.5 text-xs text-destructive">{quotaError}</p>}
      </DrawerSection>

      <DrawerSection title="角色">
        <div className="flex items-center gap-2">
          <span className="text-sm">{roleText}</span>
          {/*
            【为什么对自己禁用】把自己降级或停用，做完就再也进不来了 ——
            服务端也挡了这一手，这里只是别让人白点一次。
          */}
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={isSelf || busy}
            onClick={onToggleRole}
          >
            {a.role === "admin" ? "取消管理员" : "设为管理员"}
          </Button>
        </div>
        {selfNote("不能修改自己的角色，避免平台失去最后一个管理员。")}
      </DrawerSection>

      <DrawerSection
        title="重置密码"
        desc="生成新的一次性密码，旧密码立即失效，本人下次登录后需要改密码。"
      >
        <Button size="sm" variant="outline" disabled={isSelf || busy} onClick={onResetPassword}>
          生成一次性密码
        </Button>
        {isSelf && (
          <p className="mt-2 text-xs text-muted-foreground">
            你自己的密码请到{" "}
            <Link href="/account/security" className="underline underline-offset-2">
              账号安全
            </Link>{" "}
            修改。
          </p>
        )}
      </DrawerSection>

      <DrawerSection
        title={a.disabled ? "恢复账号" : "停用账号"}
        tone={a.disabled ? undefined : "danger"}
        desc={
          a.disabled
            ? "恢复后可以重新登录，但原有 API Key 不会自动启用，需要本人重新签发。"
            : "停用会立即登出该账号，并停用它名下的全部 API Key;智能体与历史数据保留。"
        }
      >
        <Button
          size="sm"
          variant={a.disabled ? "outline" : "destructive"}
          disabled={isSelf || busy}
          onClick={onToggleDisabled}
        >
          {a.disabled ? "恢复账号" : "停用账号"}
        </Button>
        {selfNote("不能停用你自己。")}
      </DrawerSection>

      <DrawerSection title="相关记录">
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/billing?tab=accounts">
              <Coins />
              积分账户
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/ops?tab=runs">
              <Activity />
              平台运行
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/ops?tab=audit">
              <ScrollText />
              操作记录
            </Link>
          </Button>
        </div>
      </DrawerSection>

      <p className="flex items-start gap-2 rounded-xl bg-band px-3 py-2.5 text-[13px] text-muted-foreground">
        <Lock className="mt-0.5 size-4 shrink-0" />
        会话是私有的，管理员也看不到这个账号的对话内容。
      </p>
    </AdminDrawer>
  );
}

function CreateAccountDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (email: string, password: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>创建账号</DialogTitle>
          <DialogDescription>创建后会生成一次性初始密码，本人首次登录后修改。</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!email.trim() || saving) return;
            setSaving(true);
            setError("");
            try {
              const d = await fetchJson<{ tempPassword: string; account: { email: string } }>(
                "/api/admin/accounts",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ email: email.trim(), role }),
                },
              );
              onCreated(d.account.email, d.tempPassword);
            } catch (err) {
              setError(errorText(err));
              setSaving(false);
            }
          }}
        >
          <label className="grid gap-1.5 text-[13px] text-muted-foreground">
            <span>
              邮箱 <span className="text-destructive">*</span>
            </span>
            <Input
              type="email"
              required
              autoFocus
              autoComplete="off"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-[13px] text-muted-foreground">
            角色
            <NativeSelect
              value={role}
              onChange={(e) => setRole(e.target.value as "user" | "admin")}
            >
              <option value="user">普通账号</option>
              <option value="admin">管理员</option>
            </NativeSelect>
          </label>
          {error && <p className="text-sm text-destructive">创建失败：{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={saving || !email.trim()}>
              {saving ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
