"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect as Select } from "@/components/ui/native-select";
import { PUBLIC_PRINCIPAL } from "@/lib/modules/access/domain/grants";
import { Globe, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface Grant {
  id: string;
  principalType: "user" | "group" | "*";
  principalId: string;
  permission: "read" | "write";
}

interface GroupOption {
  id: string;
  name: string;
}

/**
 * 助手分享面板。
 * 只在已保存的助手上显示 —— 新建中的助手还没 id,谈不上分享。
 */
export function SharePanel({ assistantId }: { assistantId: string }) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<"read" | "write">("read");
  const [msg, setMsg] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [groupOptions, setGroupOptions] = useState<GroupOption[]>([]);
  const [groupId, setGroupId] = useState("");

  const reload = useCallback(async () => {
    const res = await fetch(`/api/assistants/${assistantId}/share`);
    if (res.status === 403) {
      setDenied(true);
      return;
    }
    const d = (await res.json()) as { grants?: Grant[] };
    setDenied(false);
    setGrants(d.grants ?? []);
  }, [assistantId]);

  useEffect(() => {
    void reload();
    void fetch("/api/groups")
      .then((r) => r.json())
      .then((d: { groups?: GroupOption[] }) => setGroupOptions(d.groups ?? []))
      .catch(() => {});
  }, [reload]);

  async function share(target: string) {
    setMsg(null);
    const res = await fetch(`/api/assistants/${assistantId}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, permission }),
    });
    const d = (await res.json()) as { error?: string };
    if (!res.ok) {
      setMsg(d.error ?? `HTTP ${res.status}`);
      return;
    }
    setEmail("");
    await reload();
  }

  async function revoke(grantId: string) {
    await fetch(`/api/assistants/${assistantId}/share?grantId=${encodeURIComponent(grantId)}`, {
      method: "DELETE",
    });
    await reload();
  }

  if (denied) {
    return (
      <p className="text-xs opacity-45">
        这个助手是别人分享给你的 —— 可以使用,但不能改它的分享设置。
      </p>
    );
  }

  const publicGrant = grants.find(
    (g) => g.principalType === "*" || g.principalId === PUBLIC_PRINCIPAL,
  );
  const userGrants = grants.filter((g) => g.principalType === "user");
  const groupGrants = grants.filter((g) => g.principalType === "group");
  const groupName = (id: string) => groupOptions.find((g) => g.id === id)?.name ?? id;
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-xs">分享</span>
        {publicGrant ? (
          <Button type="button" variant="outline" size="sm" onClick={() => revoke(publicGrant.id)}>
            <Globe className="size-3.5" />
            取消公开(当前:所有登录用户可{publicGrant.permission === "write" ? "改" : "用"})
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => share("public")}>
            <Globe className="size-3.5" />
            公开给所有登录用户
          </Button>
        )}
      </div>

      <div className="flex gap-2">
        <Input
          className="h-8 flex-1 text-xs"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && email.trim() && share(email.trim())}
          placeholder="同事的邮箱"
        />
        <Select
          className="h-8 w-auto text-xs"
          value={permission}
          onChange={(e) => setPermission(e.target.value as "read" | "write")}
        >
          <option value="read">可使用</option>
          <option value="write">可修改</option>
        </Select>
        <Button
          type="button"
          size="sm"
          onClick={() => share(email.trim())}
          disabled={!email.trim()}
        >
          分享
        </Button>
      </div>

      {groupOptions.length > 0 && (
        <div className="flex gap-2">
          <Select
            className="h-8 flex-1 text-xs"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
          >
            <option value="">选择用户组…</option>
            {groupOptions.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            size="sm"
            onClick={() => groupId && share(`group:${groupId}`)}
            disabled={!groupId}
          >
            分享给全组
          </Button>
        </div>
      )}

      {msg && <p className="text-xs text-destructive">{msg}</p>}

      {userGrants.length === 0 && groupGrants.length === 0 && !publicGrant && (
        <p className="text-xs text-muted-foreground">尚未分享给任何人</p>
      )}
      {groupGrants.map((g) => (
        <div
          key={g.id}
          className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
        >
          <Users className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate">{groupName(g.principalId)}</span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {g.permission === "write" ? "可修改" : "可使用"}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="撤销"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => revoke(g.id)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      {userGrants.map((g) => (
        <div
          key={g.id}
          className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
        >
          <span className="flex-1 truncate font-mono text-muted-foreground">{g.principalId}</span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {g.permission === "write" ? "可修改" : "可使用"}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="撤销"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => revoke(g.id)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  );
}
