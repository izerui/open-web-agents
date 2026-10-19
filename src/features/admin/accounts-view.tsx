"use client";

import { useConfirm } from "@/components/confirm-dialog";
import { OneTimeSecretDialog } from "@/components/one-time-secret-dialog";
import { SpaceShell } from "@/components/space-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { formatUsd } from "@/lib/modules/usage/domain/aggregate";
import { peekMe } from "@/lib/use-me";
import { cn } from "@/lib/utils";
import { Ban, Check, KeyRound, ShieldCheck, User as UserIcon, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface Account {
  id: string;
  email: string;
  role: "admin" | "user";
  disabled: boolean;
  createdAt: number;
  agentCount: number;
  monthCostMicroUsd: number;
  monthlyQuotaMicroUsd: number | null;
}

/** 微美元 ↔ 美元。界面上填的是美元,存的是微美元。 */
const toMicro = (usd: number) => Math.round(usd * 1_000_000);
const toUsd = (micro: number) => micro / 1_000_000;

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
    // 清空 = 取消限额,和"填 0"是两回事(0 意味着一分钱都不许花)
    const value = raw === "" ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      toast.error("额度要填一个非负数字,或留空表示不限");
      return;
    }
    const ok = await patch(
      a.id,
      { monthlyQuotaMicroUsd: value === null ? null : toMicro(value) },
      value === null ? "已取消该账号的额度限制" : `额度已设为 $${value}`,
    );
    if (!ok) return;
    setQuotaDraft((m) => {
      const next = { ...m };
      delete next[a.id];
      return next;
    });
  }

  const totalCost = accounts.reduce((s, a) => s + a.monthCostMicroUsd, 0);
  const activeCount = accounts.filter((a) => !a.disabled).length;

  return (
    <SpaceShell
      area="admin"
      title="账号管理"
      subtitle={`${accounts.length} 个账号 · ${activeCount} 个启用中 · 本月合计 ${formatUsd(totalCost)}`}
    >
      {confirm.dialog}
      <OneTimeSecretDialog
        title={secret?.title ?? ""}
        description="这是一次性的初始密码,关闭后无法再次查看。请转交给账号使用者,并提醒其登录后在「账号安全」里修改。"
        secret={secret?.value ?? null}
        onClose={() => setSecret(null)}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">创建账号</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void createAccount();
            }}
          >
            <Input
              type="email"
              required
              className="h-8 min-w-48 flex-1 text-xs"
              placeholder="name@company.com"
              aria-label="新账号邮箱"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
            <select
              className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
              aria-label="角色"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as "user" | "admin")}
            >
              <option value="user">普通账号</option>
              <option value="admin">管理员</option>
            </select>
            <Button type="submit" size="sm" disabled={creating || !newEmail.trim()}>
              <UserPlus className="size-3.5" />
              创建
            </Button>
          </form>
        </CardContent>
      </Card>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          载入中…
        </div>
      )}

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="space-y-2 p-4">
            <p className="text-xs text-destructive">账号列表加载失败:{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && !error && accounts.length === 0 && (
        <p className="text-xs text-muted-foreground">还没有任何账号</p>
      )}

      <div className="space-y-2">
        {accounts.map((a) => {
          const isSelf = a.id === selfId;
          const over =
            a.monthlyQuotaMicroUsd !== null && a.monthCostMicroUsd >= a.monthlyQuotaMicroUsd;
          return (
            <Card key={a.id} className={cn(a.disabled && "opacity-60")}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.email}</span>
                  {a.role === "admin" && (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      <ShieldCheck className="size-3" />
                      管理员
                    </Badge>
                  )}
                  {a.disabled && (
                    <Badge variant="destructive" className="shrink-0 text-[10px]">
                      已停用
                    </Badge>
                  )}
                  {isSelf && (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      你自己
                    </Badge>
                  )}
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>注册于 {new Date(a.createdAt).toLocaleDateString()}</span>
                  <span>{a.agentCount} 个智能体</span>
                  <span className={cn(over && "font-medium text-warning")}>
                    本月 {formatUsd(a.monthCostMicroUsd)}
                    {a.monthlyQuotaMicroUsd !== null &&
                      ` / 上限 ${formatUsd(a.monthlyQuotaMicroUsd)}`}
                    {over && " —— 已超额"}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">月度上限 $</span>
                    <Input
                      className="h-7 w-24 text-xs"
                      inputMode="decimal"
                      placeholder={a.monthlyQuotaMicroUsd === null ? "不限" : ""}
                      value={
                        quotaDraft[a.id] ??
                        (a.monthlyQuotaMicroUsd === null
                          ? ""
                          : String(toUsd(a.monthlyQuotaMicroUsd)))
                      }
                      onChange={(e) => setQuotaDraft((m) => ({ ...m, [a.id]: e.target.value }))}
                    />
                  </label>
                  {quotaDraft[a.id] !== undefined && (
                    <Button
                      size="sm"
                      className="h-7"
                      disabled={busy === a.id}
                      onClick={() => void saveQuota(a)}
                    >
                      <Check className="size-3.5" />
                      保存额度
                    </Button>
                  )}

                  <div className="ml-auto flex items-center gap-2">
                    {/*
                      【为什么对自己禁用这两个按钮】把自己降级或停用,做完就再也
                      进不来了 —— 服务端也挡了这一手,这里只是别让人白点一次。
                    */}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7"
                      disabled={isSelf || busy === a.id}
                      title={isSelf ? "不能改自己的角色" : undefined}
                      onClick={() =>
                        void patch(
                          a.id,
                          { role: a.role === "admin" ? "user" : "admin" },
                          a.role === "admin" ? "已取消管理员" : "已设为管理员",
                        )
                      }
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

                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7"
                      disabled={busy === a.id}
                      onClick={() =>
                        confirm.ask({
                          title: `重置 ${a.email} 的密码?`,
                          description: "旧密码立即失效,系统会生成一个一次性的新密码供你转交。",
                          confirmLabel: "重置",
                          onConfirm: async () => {
                            const d = await patch(a.id, { resetPassword: true }, "密码已重置");
                            if (d?.tempPassword) {
                              setSecret({ title: `${a.email} 的新密码`, value: d.tempPassword });
                            }
                          },
                        })
                      }
                    >
                      <KeyRound className="size-3.5" />
                      重置密码
                    </Button>

                    <Button
                      variant={a.disabled ? "outline" : "ghost"}
                      size="sm"
                      className={cn("h-7", !a.disabled && "text-destructive")}
                      disabled={isSelf || busy === a.id}
                      title={isSelf ? "不能停用自己" : undefined}
                      onClick={() =>
                        a.disabled
                          ? void patch(a.id, { disabled: false }, "已恢复该账号")
                          : confirm.ask({
                              title: `停用 ${a.email}?`,
                              description:
                                "其登录立即失效,签发的 API Key 也一并停用。之后可以随时恢复。",
                              confirmLabel: "停用",
                              destructive: true,
                              onConfirm: async () => {
                                await patch(a.id, { disabled: true }, "已停用该账号");
                              },
                            })
                      }
                    >
                      <Ban className="size-3.5" />
                      {a.disabled ? "恢复" : "停用"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </SpaceShell>
  );
}
