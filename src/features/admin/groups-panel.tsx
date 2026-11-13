"use client";

import { useConfirm } from "@/components/confirm-dialog";
import { LoadError } from "@/components/load-error";
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
import { Spinner } from "@/components/ui/spinner";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { ChevronRight, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AdminDrawer, DrawerSection, EmptyState, Initial, TD, TH, TableCard } from "./admin-ui";

interface GroupRow {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  ownerEmail?: string;
  createdAt: number;
  memberCount: number;
  /** 有几个智能体把权限授给了这个组 */
  grantCount: number;
}

interface Member {
  userId: string;
  email: string;
  joinedAt: number;
}

function dateText(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function GroupIcon({ big = false }: { big?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center bg-[#E6DFD1] text-[#3B362D]",
        big ? "size-11 rounded-[14px]" : "size-7 rounded-[9px]",
      )}
    >
      <Users className={big ? "size-5" : "size-[15px]"} />
    </span>
  );
}

/**
 * 用户组（A15,平台管理 · 账号的第二个页签）。
 *
 * 组的归属：按创建者（groups.owner_id）。`/api/groups` 默认只列自己建的，
 * 这里按管理员语义带 `scope=all` 看全平台；成员管理与删除允许组的创建者或管理员。
 * 管理员在这里新建的组归管理员自己。
 */
export function GroupsPanel({
  creating,
  onCreatingChange,
  onCount,
}: {
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
  onCount: (n: number) => void;
}) {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchJson<{ groups: GroupRow[] }>("/api/groups?scope=all");
      setGroups(d.groups);
      onCount(d.groups.length);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [onCount]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = groups.find((g) => g.id === selectedId) ?? null;

  return (
    <>
      <TableCard>
        {error ? (
          <LoadError what="用户组" message={error} onRetryAction={() => void load()} />
        ) : loading && groups.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            正在加载用户组…
          </div>
        ) : groups.length === 0 ? (
          <EmptyState
            title="还没有用户组"
            action={
              <Button size="sm" onClick={() => onCreatingChange(true)}>
                新建组
              </Button>
            }
          >
            建一个组，把同部门的人放进去，分享智能体时可以一次授权给整个组。
          </EmptyState>
        ) : (
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH}>名称</th>
                <th className={TH}>成员数</th>
                <th className={TH}>用在授权上</th>
                <th className={TH}>创建者</th>
                <th className={TH}>创建时间</th>
                <th className={TH}>
                  <span className="sr-only">详情</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const active = g.id === selectedId;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: 整行可点只是鼠标的便利,键盘用行内的按钮或链接
                  <tr
                    key={g.id}
                    onClick={() => setSelectedId(active ? null : g.id)}
                    className={cn(
                      "cursor-pointer hover:bg-[#FAF9F6]",
                      active && "bg-[#F4F2EC] hover:bg-[#F4F2EC]",
                    )}
                  >
                    <td className={TD}>
                      <button
                        type="button"
                        aria-pressed={active}
                        aria-label={`查看用户组 ${g.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedId(active ? null : g.id);
                        }}
                        className="flex min-h-7 items-center gap-2 text-left font-semibold outline-none focus-visible:underline"
                      >
                        <GroupIcon />
                        {g.name}
                      </button>
                    </td>
                    <td className={TD}>{g.memberCount} 人</td>
                    <td className={TD}>
                      {g.grantCount ? (
                        `${g.grantCount} 个智能体`
                      ) : (
                        <span className="text-muted-foreground">没有</span>
                      )}
                    </td>
                    <td className={cn(TD, "break-all text-muted-foreground")}>
                      {g.ownerEmail ?? g.ownerId}
                    </td>
                    <td className={cn(TD, "whitespace-nowrap text-muted-foreground")}>
                      {dateText(g.createdAt)}
                    </td>
                    <td className={cn(TD, "text-right text-muted-foreground")}>
                      <ChevronRight className="ml-auto size-4" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </TableCard>

      {selected && (
        <GroupDrawer
          key={selected.id}
          group={selected}
          onClose={() => setSelectedId(null)}
          onChanged={load}
          onDeleted={async () => {
            setSelectedId(null);
            await load();
          }}
        />
      )}
      {creating && (
        <CreateGroupDialog
          onClose={() => onCreatingChange(false)}
          onCreated={async (id) => {
            onCreatingChange(false);
            await load();
            setSelectedId(id);
          }}
        />
      )}
    </>
  );
}

function GroupDrawer({
  group,
  onClose,
  onChanged,
  onDeleted,
}: {
  group: GroupRow;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [addError, setAddError] = useState("");
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const base = `/api/groups/${encodeURIComponent(group.id)}`;

  const loadMembers = useCallback(async () => {
    try {
      const d = await fetchJson<{ members: Member[] }>(`${base}/members`);
      setMembers(d.members);
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }, [base]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  async function add() {
    const value = email.trim();
    if (!value || busy) return;
    if (members?.some((m) => m.email.toLowerCase() === value.toLowerCase())) {
      setAddError("已经是这个组的成员");
      return;
    }
    setBusy(true);
    setAddError("");
    try {
      const d = await fetchJson<{ members: Member[] }>(`${base}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      setMembers(d.members);
      setEmail("");
      toast.success(`已把 ${value} 加入「${group.name}」`);
      await onChanged();
    } catch (e) {
      setAddError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: Member) {
    setBusy(true);
    try {
      const d = await fetchJson<{ members: Member[] }>(
        `${base}/members?userId=${encodeURIComponent(m.userId)}`,
        { method: "DELETE" },
      );
      setMembers(d.members);
      toast.success(`已移除 ${m.email}`);
      await onChanged();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminDrawer
      label={`用户组 ${group.name} 的详情`}
      onClose={onClose}
      head={
        <div className="flex items-center gap-3">
          <GroupIcon big />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{group.name}</div>
            <div className="text-xs text-muted-foreground">
              {members?.length ?? group.memberCount} 位成员，创建于 {dateText(group.createdAt)}
            </div>
          </div>
        </div>
      }
    >
      {confirm.dialog}
      {group.description && <p className="text-sm text-muted-foreground">{group.description}</p>}
      <DrawerSection
        title="添加成员"
        desc="按邮箱添加已有账号；加入后立即获得这个组被授予的智能体权限。"
      >
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Input
            type="email"
            className="flex-1"
            placeholder="name@company.com"
            aria-label="成员邮箱"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setAddError("");
            }}
          />
          <Button type="submit" size="sm" disabled={busy || !email.trim()}>
            添加
          </Button>
        </form>
        {addError && <p className="mt-1.5 text-xs text-destructive">{addError}</p>}
      </DrawerSection>

      <section className="rounded-[14px] border border-border px-2 py-3">
        <h3 className="px-2 pb-1 text-sm font-semibold">成员（{members?.length ?? "…"}）</h3>
        {error ? (
          <LoadError
            compact
            what="成员列表"
            message={error}
            onRetryAction={() => void loadMembers()}
          />
        ) : members === null ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">正在加载成员…</p>
        ) : members.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">还没有成员，在上面按邮箱添加。</p>
        ) : (
          <ul>
            {members.map((m) => (
              <li
                key={m.userId}
                className="flex items-center gap-2.5 border-t border-line-soft px-2 py-2 first:border-t-0"
              >
                <Initial text={m.email} />
                <span className="min-w-0 flex-1 break-all text-sm">{m.email}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  aria-label={`把 ${m.email} 移出组`}
                  onClick={() => void remove(m)}
                >
                  移除
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <DrawerSection
        title="授权情况"
        desc={
          group.grantCount
            ? `这个组用在 ${group.grantCount} 个智能体的定向分享上。授权由各智能体的所有者在构建页「发布」阶段的分享里管理。`
            : "还没有智能体分享给这个组。所有者可以在构建页「发布」阶段的分享里选择这个组。"
        }
      />

      <DrawerSection
        title="删除组"
        tone="danger"
        desc="删除后，通过这个组获得的智能体权限一并收回；成员账号本身不受影响。"
      >
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() =>
            confirm.ask({
              title: `删除「${group.name}」？`,
              description: `${members?.length ?? group.memberCount} 位成员会失去经由这个组获得的权限${
                group.grantCount ? `（涉及 ${group.grantCount} 个智能体）` : ""
              }。删除后不能撤销。`,
              confirmLabel: "删除组",
              destructive: true,
              onConfirm: async () => {
                try {
                  await fetchJson(base, { method: "DELETE" });
                  toast.success(`已删除「${group.name}」`);
                  await onDeleted();
                } catch (e) {
                  toast.error(errorText(e));
                }
              },
            })
          }
        >
          删除组
        </Button>
      </DrawerSection>
    </AdminDrawer>
  );
}

function CreateGroupDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>新建用户组</DialogTitle>
          <DialogDescription>
            建好后在组详情里按邮箱添加成员；所有者分享智能体时可以选这个组。
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim() || saving) return;
            setSaving(true);
            setError("");
            try {
              const d = await fetchJson<{ group: { id: string } }>("/api/groups", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  name: name.trim(),
                  description: description.trim() || undefined,
                }),
              });
              toast.success(`已建组「${name.trim()}」`);
              onCreated(d.group.id);
            } catch (err) {
              setError(errorText(err));
              setSaving(false);
            }
          }}
        >
          <label className="grid gap-1.5 text-[13px] text-muted-foreground">
            <span>
              名称 <span className="text-destructive">*</span>
            </span>
            <Input
              required
              autoFocus
              maxLength={255}
              placeholder="如 财务部"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-[13px] text-muted-foreground">
            说明（可选）
            <Input
              maxLength={1024}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "创建中…" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
