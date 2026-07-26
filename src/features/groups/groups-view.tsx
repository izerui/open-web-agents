"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

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

const field =
  "rounded border border-black/15 bg-transparent px-2 py-1 text-xs outline-none focus:border-black/40 dark:border-white/20";

export function GroupsView() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const d = (await fetch("/api/groups").then((r) => r.json())) as { groups?: Group[] };
    setGroups(d.groups ?? []);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadMembers = useCallback(async (id: string) => {
    setSelected(id);
    setMsg(null);
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
      setMsg(d.error ?? `HTTP ${res.status}`);
      return;
    }
    setName("");
    await reload();
    if (d.group) await loadMembers(d.group.id);
  }

  async function addMember() {
    if (!selected || !email.trim()) return;
    setMsg(null);
    const res = await fetch(`/api/groups/${selected}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });
    const d = (await res.json()) as { members?: Member[]; error?: string };
    if (!res.ok) {
      setMsg(d.error ?? `HTTP ${res.status}`);
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
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-lg">用户组</h1>
          <p className="text-xs opacity-55">
            把助手分享给整个团队,不必逐个点人。组变动后授权自动跟着变。
          </p>
        </div>
        <div className="flex gap-3 text-xs">
          <Link href="/" className="underline opacity-60 hover:opacity-100">
            工作台
          </Link>
          <Link href="/builder" className="underline opacity-60 hover:opacity-100">
            构建器
          </Link>
          <Link href="/settings" className="underline opacity-60 hover:opacity-100">
            设置
          </Link>
        </div>
      </header>

      <div className="flex gap-2">
        <input
          className={`${field} flex-1`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createGroup()}
          placeholder="新组名称,如「内容团队」"
        />
        <button
          type="button"
          className="rounded bg-black px-3 py-1 text-white text-xs disabled:opacity-40 dark:bg-white dark:text-black"
          onClick={createGroup}
          disabled={!name.trim()}
        >
          建组
        </button>
      </div>

      {msg && <p className="text-red-600 text-xs">{msg}</p>}

      <div className="grid grid-cols-[220px_1fr] gap-4">
        <div className="space-y-1">
          {groups.length === 0 && <p className="text-xs opacity-40">还没有组</p>}
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-black/5 dark:hover:bg-white/10 ${
                g.id === selected ? "bg-black/5 dark:bg-white/10" : ""
              }`}
              onClick={() => loadMembers(g.id)}
            >
              {g.name}
              <span className="ml-1 opacity-50">· {g.memberCount} 人</span>
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {!current && <p className="text-xs opacity-40">选一个组来管理成员</p>}
          {current && (
            <>
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">{current.name}</span>
                <code className="font-mono text-xs opacity-45">group:{current.id}</code>
              </div>
              <p className="text-xs opacity-55">
                在构建器的分享面板里选这个组,即可把助手分享给全组。
              </p>

              <div className="flex gap-2">
                <input
                  className={`${field} flex-1`}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addMember()}
                  placeholder="成员邮箱"
                />
                <button
                  type="button"
                  className="rounded bg-black px-3 py-1 text-white text-xs disabled:opacity-40 dark:bg-white dark:text-black"
                  onClick={addMember}
                  disabled={!email.trim()}
                >
                  加入
                </button>
              </div>

              {members.length === 0 && <p className="text-xs opacity-40">组内还没有成员</p>}
              {members.map((m) => (
                <div key={m.userId} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 truncate">{m.email}</span>
                  <button
                    type="button"
                    className="text-red-600 underline opacity-70 hover:opacity-100"
                    onClick={() => removeMember(m.userId)}
                  >
                    移出
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
