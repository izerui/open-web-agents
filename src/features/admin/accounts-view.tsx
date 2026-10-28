"use client";

import { useConfirm } from "@/components/confirm-dialog";
import { LoadError } from "@/components/load-error";
import { OneTimeSecretDialog } from "@/components/one-time-secret-dialog";
import { SpaceShell } from "@/components/space-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { creditsAmount } from "@/lib/modules/billing/domain/credits-display";
import { formatCredits, parseCredits } from "@/lib/modules/capabilities/domain/catalog";
import { peekMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Ban,
  Check,
  KeyRound,
  Search,
  ShieldCheck,
  User as UserIcon,
  UserPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface Account {
  id: string;
  email: string;
  role: "admin" | "user";
  disabled: boolean;
  createdAt: number;
  agentCount: number;
  /** 本月已用(微积分;实扣 + 欠额 + 在途冻结) */
  monthUsedMicroCredits: string;
  monthlyLimitMicroCredits: string | null;
  /** 升级遗留的美元上限(微美元),待按积分重新设置 */
  legacyLimitMicroUsd: number | null;
}

/**
 * 平台账号管理。
 *
 * 【为什么这个页面必须存在】role 只在注册时定死(第一个注册者是 admin),
 * 代码里原本没有任何接口能改它 —— 加个管理员、停用一个滥用的账号,
 * 都只能连数据库跑 SQL。一个要交给运营的平台不能是这样。
 */
export function AccountsView() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [quotaDraft, setQuotaDraft] = useState<Record<string, string>>({});
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"user" | "admin">("user");
  const [creating, setCreating] = useState(false);
  /** 刚生成的一次性密码(建号或重置),只展示这一次。 */
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "user">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const confirm = useConfirm();

  const selfId = peekMe()?.user?.id;

  const load = useCallback(async () => {
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

  /**
   * 返回是否成功。曾经没有 catch(网络错误成了未处理的 rejection)、失败也不告诉调用方,
   * 于是保存额度失败后草稿照样被清空,刚填的数字就丢了。
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
      await load();
      return d;
    } catch (e) {
      // 服务端的拒绝理由写得很具体(如"这是最后一位管理员"),原样呈现
      toast.error(errorText(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function createAccount() {
    if (!newEmail.trim() || creating) return;
    setCreating(true);
    try {
      const d = await fetchJson<{ tempPassword: string; account: { email: string } }>(
        "/api/admin/accounts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: newEmail.trim(), role: newRole }),
        },
      );
      setNewEmail("");
      setSecret({ title: `已创建 ${d.account.email}`, value: d.tempPassword });
      await load();
    } catch (e) {
      toast.error(`创建失败:${errorText(e)}`);
    } finally {
      setCreating(false);
    }
  }

  async function saveQuota(a: Account) {
    const raw = quotaDraft[a.id]?.trim() ?? "";
    // 清空 = 取消限额,和"填 0"是两回事(0 意味着一个积分都不许花)
    if (raw !== "") {
      try {
        parseCredits(raw);
      } catch {
        toast.error("上限要填非负积分数(最多六位小数),或留空表示不限");
        return;
      }
    }
    const ok = await patch(
      a.id,
      { monthlyLimitCredits: raw === "" ? null : raw },
      raw === "" ? "已取消该账号的月度上限" : `月度上限已设为 ${raw} 积分`,
    );
    if (!ok) return;
    setQuotaDraft((m) => {
      const next = { ...m };
      delete next[a.id];
      return next;
    });
  }

  const totalUsed = accounts.reduce((s, a) => s + BigInt(a.monthUsedMicroCredits), 0n);
  const activeCount = accounts.filter((a) => !a.disabled).length;
  const needle = query.trim().toLocaleLowerCase();
  const shown = accounts.filter(
    (a) =>
      (!needle || a.email.toLocaleLowerCase().includes(needle)) &&
      (roleFilter === "all" || a.role === roleFilter),
  );
  const selected = accounts.find((a) => a.id === selectedId) ?? null;

  return (
    <SpaceShell
      area="admin"
      title="账号管理"
      width="flush"
      subtitle={`${accounts.length} 个账号 · ${activeCount} 个启用中 · 本月消耗 ${creditsAmount(totalUsed)} 积分`}
    >
      {confirm.dialog}
      <OneTimeSecretDialog
        title={secret?.title ?? ""}
        description="这是一次性的初始密码,关闭后无法再次查看。请转交给账号使用者,并提醒其登录后在「账号安全」里修改。"
        secret={secret?.value ?? null}
        onClose={() => setSecret(null)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 工具栏行:左边筛选,右边建号 */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
          <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input bg-background px-2 focus-within:border-ring sm:w-56 sm:flex-none">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="按邮箱筛选"
              aria-label="按邮箱筛选"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </label>
          <NativeSelect
            className="h-7 w-28"
            aria-label="按角色筛选"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as typeof roleFilter)}
          >
            <option value="all">全部角色</option>
            <option value="admin">管理员</option>
            <option value="user">普通账号</option>
          </NativeSelect>
          <span className="flex-1" />
          <form
            className="flex w-full items-center gap-2 sm:w-auto"
            onSubmit={(e) => {
              e.preventDefault();
              void createAccount();
            }}
          >
            <Input
              type="email"
              required
              className="h-7 min-w-0 flex-1 sm:w-56 sm:flex-none"
              placeholder="新账号邮箱 name@company.com"
              aria-label="新账号邮箱"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
            <NativeSelect
              className="h-7 w-28"
              aria-label="角色"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as "user" | "admin")}
            >
              <option value="user">普通账号</option>
              <option value="admin">管理员</option>
            </NativeSelect>
            <Button type="submit" size="sm" disabled={creating || !newEmail.trim()}>
              <UserPlus className="size-3.5" />
              创建
            </Button>
          </form>
        </div>

        {error ? (
          <LoadError what="账号列表" message={error} onRetryAction={() => void load()} />
        ) : loading ? (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            载入中…
          </div>
        ) : accounts.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">还没有任何账号</p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            {/*
              【为什么是表格】改造前每个账号一张 170px 高的卡片,311 个账号一屏只看得到 4 个;
              运营要做的是"扫一遍、挑出异常的那几个",这需要一行一个、列对齐。
              改额度、改角色、停用这些写操作挪进右侧详情,行上只留能扫读的数字。
            */}
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-background text-xs text-muted-foreground">
                <tr className="h-7 border-b border-border text-left">
                  <th className="px-3 font-normal">邮箱</th>
                  <th className="w-24 px-3 font-normal">角色</th>
                  <th className="hidden w-28 px-3 font-normal lg:table-cell">注册日期</th>
                  <th className="hidden w-20 px-3 text-right font-normal md:table-cell">智能体</th>
                  <th className="w-32 px-3 text-right font-normal">本月消耗(积分)</th>
                  <th className="hidden w-28 px-3 text-right font-normal sm:table-cell">
                    月度上限
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  const over = isOver(a);
                  const active = a.id === selectedId;
                  return (
                    <tr
                      key={a.id}
                      className={cn(
                        "h-8 border-b border-border/60",
                        active ? "bg-sidebar-active" : "hover:bg-accent/50",
                        a.disabled && "text-muted-foreground",
                      )}
                    >
                      <td className="max-w-0 px-3">
                        <button
                          type="button"
                          onClick={() => setSelectedId(active ? null : a.id)}
                          aria-pressed={active}
                          className="flex w-full min-w-0 items-center gap-2 text-left outline-none focus-visible:underline"
                        >
                          <span className="truncate">{a.email}</span>
                          {a.id === selfId && (
                            <span className="shrink-0 text-xs text-muted-foreground">你自己</span>
                          )}
                          {a.disabled && (
                            <Badge variant="destructive" className="h-4 shrink-0 px-1 text-[10px]">
                              已停用
                            </Badge>
                          )}
                          {a.legacyLimitMicroUsd !== null && (
                            <AlertTriangle
                              className="size-3.5 shrink-0 text-warning"
                              aria-label="旧上限待重新设置"
                            />
                          )}
                        </button>
                      </td>
                      <td className="px-3">
                        {a.role === "admin" ? (
                          <span className="inline-flex items-center gap-1 text-info">
                            <ShieldCheck className="size-3.5" />
                            管理员
                          </span>
                        ) : (
                          <span className="text-muted-foreground">普通账号</span>
                        )}
                      </td>
                      <td className="hidden px-3 font-mono text-xs text-muted-foreground lg:table-cell">
                        {new Date(a.createdAt).toLocaleDateString()}
                      </td>
                      <td className="hidden px-3 text-right font-mono text-xs md:table-cell">
                        {a.agentCount}
                      </td>
                      <td
                        className={cn(
                          "px-3 text-right font-mono text-xs",
                          over && "font-medium text-warning",
                        )}
                      >
                        {creditsAmount(a.monthUsedMicroCredits)}
                      </td>
                      <td className="hidden px-3 text-right font-mono text-xs text-muted-foreground sm:table-cell">
                        {a.monthlyLimitMicroCredits === null
                          ? "不限"
                          : creditsAmount(a.monthlyLimitMicroCredits)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length === 0 && (
              <p className="p-4 text-xs text-muted-foreground">没有符合条件的账号</p>
            )}
          </div>
        )}
      </div>

      {selected && (
        <AccountDetail
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
          quotaDirty={quotaDraft[selected.id] !== undefined}
          onQuotaChangeAction={(v) => setQuotaDraft((m) => ({ ...m, [selected.id]: v }))}
          onSaveQuotaAction={() => void saveQuota(selected)}
          onCloseAction={() => setSelectedId(null)}
          onToggleRoleAction={() =>
            void patch(
              selected.id,
              { role: selected.role === "admin" ? "user" : "admin" },
              selected.role === "admin" ? "已取消管理员" : "已设为管理员",
            )
          }
          onResetPasswordAction={() =>
            confirm.ask({
              title: `重置 ${selected.email} 的密码?`,
              description: "旧密码立即失效,系统会生成一个一次性的新密码供你转交。",
              confirmLabel: "重置",
              onConfirm: async () => {
                const d = await patch(selected.id, { resetPassword: true }, "密码已重置");
                if (d?.tempPassword) {
                  setSecret({ title: `${selected.email} 的新密码`, value: d.tempPassword });
                }
              },
            })
          }
          onToggleDisabledAction={() =>
            selected.disabled
              ? void patch(selected.id, { disabled: false }, "已恢复该账号")
              : confirm.ask({
                  title: `停用 ${selected.email}?`,
                  description: "其登录立即失效,签发的 API Key 也一并停用。之后可以随时恢复。",
                  confirmLabel: "停用",
                  destructive: true,
                  onConfirm: async () => {
                    await patch(selected.id, { disabled: true }, "已停用该账号");
                  },
                })
          }
        />
      )}
    </SpaceShell>
  );
}

function isOver(a: Account): boolean {
  return (
    a.monthlyLimitMicroCredits !== null &&
    BigInt(a.monthUsedMicroCredits) >= BigInt(a.monthlyLimitMicroCredits)
  );
}

/**
 * 选中账号的详情与写操作。
 *
 * 【为什么停用单独沉到最底下】改造前"停用"和"重置密码"并排挨着,都是行尾的小按钮,
 * 手一滑就点错。危险操作放在单独的一段、红色描边,和日常操作隔开一屏的距离。
 */
function AccountDetail({
  account: a,
  isSelf,
  busy,
  quota,
  quotaDirty,
  onQuotaChangeAction,
  onSaveQuotaAction,
  onCloseAction,
  onToggleRoleAction,
  onResetPasswordAction,
  onToggleDisabledAction,
}: {
  account: Account;
  isSelf: boolean;
  busy: boolean;
  quota: string;
  quotaDirty: boolean;
  onQuotaChangeAction: (v: string) => void;
  onSaveQuotaAction: () => void;
  onCloseAction: () => void;
  onToggleRoleAction: () => void;
  onResetPasswordAction: () => void;
  onToggleDisabledAction: () => void;
}) {
  const over = isOver(a);
  return (
    <aside
      data-testid="account-detail"
      aria-label={`${a.email} 的详情`}
      className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-sidebar max-md:fixed max-md:inset-y-10 max-md:right-0 max-md:z-30 max-md:w-[88vw] max-md:shadow-lg"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{a.email}</span>
        <Button variant="ghost" size="icon-xs" aria-label="关闭详情" onClick={onCloseAction}>
          <X />
        </Button>
      </div>

      <section className="space-y-1.5 border-b border-border px-3 py-3 text-xs">
        {(a.role === "admin" || a.disabled || isSelf) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {a.role === "admin" && (
              <Badge variant="secondary" className="text-[10px]">
                <ShieldCheck className="size-3" />
                管理员
              </Badge>
            )}
            {a.disabled && (
              <Badge variant="destructive" className="text-[10px]">
                已停用
              </Badge>
            )}
            {isSelf && (
              <Badge variant="outline" className="text-[10px]">
                你自己
              </Badge>
            )}
          </div>
        )}
        <p className="flex justify-between">
          <span className="text-muted-foreground">注册于</span>
          <span className="font-mono">{new Date(a.createdAt).toLocaleDateString()}</span>
        </p>
        <p className="flex justify-between">
          <span className="text-muted-foreground">智能体</span>
          <span>{a.agentCount} 个</span>
        </p>
        <p className={cn("flex justify-between", over && "font-medium text-warning")}>
          <span className={cn(!over && "text-muted-foreground")}>本月消耗</span>
          <span>
            本月 {creditsAmount(a.monthUsedMicroCredits)} 积分
            {a.monthlyLimitMicroCredits !== null &&
              ` / 上限 ${creditsAmount(a.monthlyLimitMicroCredits)}`}
            {over && " —— 已达上限"}
          </span>
        </p>
      </section>

      <section className="space-y-2 border-b border-border px-3 py-3">
        <h3 className="text-xs font-medium">月度上限</h3>
        {a.legacyLimitMicroUsd !== null && (
          <p data-testid="legacy-limit" className="text-xs font-medium text-warning">
            旧上限 ${(a.legacyLimitMicroUsd / 1_000_000).toFixed(2)}{" "}
            待按积分重新设置(或留空保存为不限);设置前不能发起运行
          </p>
        )}
        <div className="flex items-center gap-2">
          <Input
            className="h-7 flex-1"
            inputMode="decimal"
            aria-label="月度上限(积分)"
            placeholder={a.monthlyLimitMicroCredits === null ? "不限" : ""}
            value={quota}
            onChange={(e) => onQuotaChangeAction(e.target.value)}
          />
          {(quotaDirty || a.legacyLimitMicroUsd !== null) && (
            <Button size="sm" disabled={busy} onClick={onSaveQuotaAction}>
              <Check className="size-3.5" />
              保存上限
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          留空表示不限;填 0 表示一个积分都不许花。超过上限后该账号的新运行会被拒绝。
        </p>
      </section>

      <section className="space-y-2 border-b border-border px-3 py-3">
        <h3 className="text-xs font-medium">角色与密码</h3>
        <div className="flex flex-wrap gap-2">
          {/*
            【为什么对自己禁用】把自己降级或停用,做完就再也进不来了 ——
            服务端也挡了这一手,这里只是别让人白点一次。
          */}
          <Button
            variant="outline"
            size="sm"
            disabled={isSelf || busy}
            title={isSelf ? "不能改自己的角色" : undefined}
            onClick={onToggleRoleAction}
          >
            {a.role === "admin" ? (
              <>
                <UserIcon className="size-3.5" />
                取消管理员
              </>
            ) : (
              <>
                <ShieldCheck className="size-3.5" />
                设为管理员
              </>
            )}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={onResetPasswordAction}>
            <KeyRound className="size-3.5" />
            重置密码
          </Button>
        </div>
      </section>

      <span className="flex-1" />

      <section className="space-y-2 px-3 py-3">
        <h3 className={cn("text-xs font-medium", !a.disabled && "text-destructive")}>
          {a.disabled ? "恢复账号" : "停用账号"}
        </h3>
        <p className="text-xs text-muted-foreground">
          {a.disabled
            ? "恢复后可以重新登录,API Key 需要重新签发。"
            : "停用后立即登出,签发的 API Key 一并停用。可以随时恢复。"}
        </p>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            !a.disabled && "border-destructive/50 text-destructive hover:bg-destructive/10",
          )}
          disabled={isSelf || busy}
          title={isSelf ? "不能停用自己" : undefined}
          onClick={onToggleDisabledAction}
        >
          <Ban className="size-3.5" />
          {a.disabled ? "恢复" : "停用"}
        </Button>
        {isSelf && <p className="text-xs text-muted-foreground">不能停用当前登录的账号。</p>}
      </section>
    </aside>
  );
}
