"use client";

import { Button } from "@/components/ui/button";
import { PUBLIC_PRINCIPAL } from "@/lib/modules/access/domain/grants";
import { isAdminView, useMe } from "@/lib/use-me";
import { Globe, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface Grant {
  id: string;
  principalType: "user" | "group" | "*";
  principalId: string;
  permission: "read" | "write";
}

/**
 * 助手发布面板 —— 把一个助手公开给平台上所有企业账号。
 *
 * 【为什么从"分享"缩成"发布"】原来这里能按邮箱分享给同事、能分享给用户组,
 * 那是"一个企业内有多个成员账号"才成立的模型。现在一个账号就是一个企业,
 * 企业之间不该互相分享助手 —— 那些入口分享给谁都不对。
 *
 * 【为什么还保留"公开"】平台内置的「通用助手」正是靠一条 public read 授权
 * 才对所有新注册企业可见(container.ts 播种时授予)。这条机制是平台发布
 * 公共助手的唯一途径,不能拆;但它是运营动作,所以只给管理员。
 *
 * 只在已保存的助手上显示 —— 新建中的助手还没 id,谈不上发布。
 */
export function SharePanel({ assistantId }: { assistantId: string }) {
  const { me } = useMe();
  const [grants, setGrants] = useState<Grant[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  const reload = useCallback(async () => {
    const res = await fetch(`/api/assistants/${assistantId}/share`);
    // 403 是"没权限管这个助手"，属于正常状态,单独渲染而不是当错误
    if (res.status === 403) {
      setDenied(true);
      return;
    }
    if (!res.ok) {
      setMsg(`发布状态加载失败:HTTP ${res.status}`);
      return;
    }
    const d = (await res.json()) as { grants?: Grant[] };
    setDenied(false);
    setGrants(d.grants ?? []);
  }, [assistantId]);

  const isAdmin = isAdminView(me);

  useEffect(() => {
    if (isAdmin) void reload();
  }, [reload, isAdmin]);

  // 发布是平台运营动作,企业账号看不到这一块
  if (!isAdmin) return null;

  async function publish() {
    setMsg(null);
    const res = await fetch(`/api/assistants/${assistantId}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "public", permission: "read" }),
    });
    const d = (await res.json()) as { error?: string };
    if (!res.ok) {
      setMsg(d.error ?? `HTTP ${res.status}`);
      return;
    }
    await reload();
  }

  async function revoke(grantId: string) {
    await fetch(`/api/assistants/${assistantId}/share?grantId=${encodeURIComponent(grantId)}`, {
      method: "DELETE",
    });
    await reload();
  }

  if (denied) {
    return <p className="text-xs opacity-45">这个助手不归你管,不能改它的发布状态。</p>;
  }

  const publicGrant = grants.find(
    (g) => g.principalType === "*" || g.principalId === PUBLIC_PRINCIPAL,
  );
  /**
   * 遗留的定向授权(按用户/按组)。
   * 【为什么还要显示】旧模型下产生的数据不会自己消失,而新界面已经没有
   * 任何地方能看到它们 —— 一条看不见却仍在生效的授权是最难查的问题。
   * 这里如实列出并允许撤销,让历史数据有个出口。
   */
  const legacy = grants.filter((g) => g.principalType === "user" || g.principalType === "group");

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-xs">发布</p>
          <p className="text-[11px] text-muted-foreground">
            公开后,平台上所有企业账号都能在助手列表里看到并使用它。
          </p>
        </div>
        {publicGrant ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => revoke(publicGrant.id)}
          >
            <Globe className="size-3.5" />
            取消公开
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={publish}>
            <Globe className="size-3.5" />
            公开给所有账号
          </Button>
        )}
      </div>

      {msg && <p className="text-xs text-destructive">{msg}</p>}

      {legacy.length > 0 && (
        <div className="space-y-1 border-t border-border pt-2">
          <p className="text-[11px] text-muted-foreground">
            遗留的定向授权(旧的分享模型留下的,建议清理):
          </p>
          {legacy.map((g) => (
            <div
              key={g.id}
              className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
            >
              <span className="flex-1 truncate font-mono text-muted-foreground">
                {g.principalType === "group" ? "组 " : ""}
                {g.principalId}
              </span>
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
      )}
    </div>
  );
}
