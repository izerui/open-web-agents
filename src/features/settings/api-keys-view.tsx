"use client";

import type { AssistantSummary } from "@/features/workbench/types";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { SettingsShell } from "@/components/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect as Select } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { errorText, fetchJson } from "@/lib/fetch-json";

interface KeyRecord {
  id: string;
  name?: string;
  assistantId?: string;
  createdAt: number;
  lastUsedAt?: number;
}

/** 对外 API Key:给第三方系统调用助手用。 */
export function ApiKeysView() {
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [assistants, setAssistants] = useState<AssistantSummary[]>([]);
  const [keyName, setKeyName] = useState("");
  const [keyAssistant, setKeyAssistant] = useState("");
  /** 新签发的明文,只在本次会话内显示一次 */
  const [issued, setIssued] = useState<string | null>(null);

  /**
   * 两块数据各拉各的。
   *
   * 【为什么并行且互不牵连】顺序 await 且不看 res.ok 的话,
   * 任一个挂掉后面的根本不会执行,整页空白且无任何提示。
   * 现在任一块失败只影响它自己,并且说得出是哪一块出了问题。
   */
  const reload = useCallback(async () => {
    const [k, a] = await Promise.allSettled([
      fetchJson<{ keys?: KeyRecord[] }>("/api/keys"),
      fetchJson<{ assistants?: AssistantSummary[] }>("/api/assistants"),
    ]);

    if (k.status === "fulfilled") setKeys(k.value.keys ?? []);
    else toast.error(`API Key 列表加载失败:${errorText(k.reason)}`);

    if (a.status === "fulfilled") setAssistants(a.value.assistants ?? []);
    else toast.error(`助手列表加载失败:${errorText(a.reason)}`);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function issueKey() {
    const res = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: keyName.trim() || undefined,
        assistantId: keyAssistant || undefined,
      }),
    });
    const data = (await res.json()) as { plaintext?: string; error?: string };
    if (data.plaintext) {
      setIssued(data.plaintext);
      setKeyName("");
      await reload();
    } else {
      setIssued(null);
      toast.error(`签发失败:${data.error}`);
    }
  }

  async function revokeKey(id: string) {
    await fetch(`/api/keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await reload();
  }

  return (
    <SettingsShell title="对外 API Key" width="narrow">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">对外 API Key</CardTitle>
          <CardDescription>
            给第三方系统调用助手用。明文只在签发时显示一次,服务端只存哈希。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="用途备注,如「订单系统」"
            />
            <Select value={keyAssistant} onChange={(e) => setKeyAssistant(e.target.value)}>
              <option value="">不限助手</option>
              {assistants.map((a) => (
                <option key={a.id} value={a.id}>
                  仅 {a.name}
                </option>
              ))}
            </Select>
            <Button size="sm" className="shrink-0" onClick={issueKey}>
              签发
            </Button>
          </div>

          {issued && (
            <div className="space-y-1 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3">
              <p className="font-medium text-xs">请立刻保存 —— 关闭后无法再次显示:</p>
              <code className="block break-all font-mono text-xs">{issued}</code>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => setIssued(null)}
              >
                我已保存
              </Button>
            </div>
          )}

          <Separator />

          <div className="divide-y divide-border rounded border">
            {keys.length === 0 && <p className="p-3 text-xs text-muted-foreground">暂无 key</p>}
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-3 p-2 text-xs">
                <span className="flex-1 truncate">
                  {k.name || "(未命名)"}
                  {k.assistantId && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">
                      仅 {k.assistantId}
                    </Badge>
                  )}
                </span>
                <span className="text-muted-foreground">
                  {k.lastUsedAt
                    ? `最近使用 ${new Date(k.lastUsedAt).toLocaleDateString()}`
                    : "从未使用"}
                </span>
                {/*
                  【为什么不是 h-auto p-0】那样按钮只有文字那么高(约 20px),
                  低于 24px 的最小触控尺寸,手机上很难点准 —— 而这是【吊销】,
                  一个不可撤销的破坏性操作,点不准的代价是误吊销一把还在用的 key。
                */}
                <Button
                  variant="link"
                  size="sm"
                  className="h-8 shrink-0 px-2 text-destructive"
                  onClick={() => revokeKey(k.id)}
                >
                  吊销
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </SettingsShell>
  );
}
