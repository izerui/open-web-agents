"use client";

import { PUBLIC_PRINCIPAL } from "@/lib/modules/access/domain/grants";
import { useCallback, useEffect, useState } from "react";

interface Grant {
  id: string;
  principalType: "user" | "group" | "*";
  principalId: string;
  permission: "read" | "write";
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
  const field =
    "rounded border border-black/15 bg-transparent px-2 py-1 text-xs outline-none focus:border-black/40 dark:border-white/20";

  return (
    <div className="space-y-2 rounded border border-black/10 p-3 dark:border-white/15">
      <div className="flex items-center justify-between">
        <span className="font-medium text-xs">分享</span>
        {publicGrant ? (
          <button
            type="button"
            className="text-xs underline opacity-70 hover:opacity-100"
            onClick={() => revoke(publicGrant.id)}
          >
            取消公开(当前:所有登录用户可{publicGrant.permission === "write" ? "改" : "用"})
          </button>
        ) : (
          <button
            type="button"
            className="text-xs underline opacity-60 hover:opacity-100"
            onClick={() => share("public")}
          >
            公开给所有登录用户
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <input
          className={`${field} flex-1`}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && email.trim() && share(email.trim())}
          placeholder="同事的邮箱"
        />
        <select
          className={field}
          value={permission}
          onChange={(e) => setPermission(e.target.value as "read" | "write")}
        >
          <option value="read">可使用</option>
          <option value="write">可修改</option>
        </select>
        <button
          type="button"
          className="rounded bg-black px-3 py-1 text-white text-xs disabled:opacity-40 dark:bg-white dark:text-black"
          onClick={() => share(email.trim())}
          disabled={!email.trim()}
        >
          分享
        </button>
      </div>

      {msg && <p className="text-red-600 text-xs">{msg}</p>}

      {userGrants.length === 0 && !publicGrant && (
        <p className="text-xs opacity-40">尚未分享给任何人</p>
      )}
      {userGrants.map((g) => (
        <div key={g.id} className="flex items-center gap-2 text-xs">
          <span className="flex-1 truncate font-mono opacity-70">{g.principalId}</span>
          <span className="opacity-55">{g.permission === "write" ? "可修改" : "可使用"}</span>
          <button
            type="button"
            className="text-red-600 underline opacity-70 hover:opacity-100"
            onClick={() => revoke(g.id)}
          >
            撤销
          </button>
        </div>
      ))}
    </div>
  );
}
