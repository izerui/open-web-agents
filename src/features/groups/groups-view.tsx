"use client";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface Group {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  memberCount: number;
}

interface Member {
  userId: string;
  email: string;
  joinedAt: number;
}

export function GroupsView() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");

  const reload = useCallback(async () => {
    const d = (await fetch("/api/groups").then((r) => r.json())) as { groups?: Group[] };
    setGroups(d.groups ?? []);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadMembers = useCallback(async (id: string) => {
    setSelected(id);
    const d = (await fetch(`/api/groups/${id}/members`).then((r) => r.json())) as {
      members?: Member[];
    };
    setMembers(d.members ?? []);
  }, []);

  async function createGroup() {
    if (!name.trim()) return;
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const d = (await res.json()) as { group?: Group; error?: string };
    if (!res.ok) {
      toast.error(d.error ?? `HTTP ${res.status}`);
      return;
    }
    setName("");
    await reload();
    if (d.group) await loadMembers(d.group.id);
  }

  async function addMember() {
    if (!selected || !email.trim()) return;
    const res = await fetch(`/api/groups/${selected}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });
    const d = (await res.json()) as { members?: Member[]; error?: string };
    if (!res.ok) {
      toast.error(d.error ?? `HTTP ${res.status}`);
      return;
    }
    setEmail("");
    setMembers(d.members ?? []);
    await reload();
  }

  async function removeMember(userId: string) {
    if (!selected) return;
    const res = await fetch(
      `/api/groups/${selected}/members?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
    const d = (await res.json()) as { members?: Member[] };
    setMembers(d.members ?? []);
    await reload();
  }

  const current = groups.find((g) => g.id === selected);

  return (
    <AppShell
      title="用户组"
      subtitle="把助手分享给整个团队,不必逐个点人。组变动后授权自动跟着变。"
      width="narrow"
    >
      <div className="flex gap-2">
        <Input
          className="flex-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createGroup()}
          placeholder="新组名称,如「内容团队」"
        />
        <Button size="sm" onClick={createGroup} disabled={!name.trim()}>
          建组
        </Button>
      </div>

      <div className="grid grid-cols-[220px_1fr] gap-4">
        <Card>
          <CardContent className="space-y-1 p-3">
            {groups.length === 0 && <p className="text-xs text-muted-foreground">还没有组</p>}
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                className={cn(
                  "flex w-full items-center justify-between truncate rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                  g.id === selected && "bg-accent text-accent-foreground",
                )}
                onClick={() => loadMembers(g.id)}
              >
                <span className="truncate">{g.name}</span>
                <Badge variant="secondary" className="ml-2 shrink-0">
                  {g.memberCount} 人
                </Badge>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            {!current && <p className="text-xs text-muted-foreground">选一个组来管理成员</p>}
            {current && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{current.name}</span>
                  <Badge variant="outline" className="font-mono text-xs">
                    group:{current.id}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  在构建器的分享面板里选这个组,即可把助手分享给全组。
                </p>

                <div className="flex gap-2">
                  <Input
                    className="flex-1"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addMember()}
                    placeholder="成员邮箱"
                  />
                  <Button size="sm" onClick={addMember} disabled={!email.trim()}>
                    加入
                  </Button>
                </div>

                {members.length === 0 && (
                  <p className="text-xs text-muted-foreground">组内还没有成员</p>
                )}
                <div className="space-y-1">
                  {members.map((m) => (
                    <div
                      key={m.userId}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent"
                    >
                      <span className="flex-1 truncate">{m.email}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-destructive hover:text-destructive"
                        onClick={() => removeMember(m.userId)}
                      >
                        移出
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
