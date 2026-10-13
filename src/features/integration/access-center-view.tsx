"use client";

import type { AgentSummary } from "@/features/workbench/types";
import { Copy, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { SpaceShell } from "@/components/space-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect as Select } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { InvokeSnippetTabs } from "@/features/integration/invoke-snippet";
import { WebhookSecretCard } from "@/features/integration/webhook-secret-card";
import { errorText, fetchJson } from "@/lib/fetch-json";

interface KeyRecord {
  id: string;
  name?: string;
  agentId?: string;
  createdAt: number;
  lastUsedAt?: number;
}

/**
 * 接入中心:第三方系统接入智能体需要的东西都在这一页。
 *
 * 【为什么合并】以前集成方要跑四个地方:这里签 Key、构建器底部翻 curl、
 * 「模型凭证」页设回调签名密钥,嵌入组件则根本没有界面入口。
 */
export function AccessCenterView() {
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [keyName, setKeyName] = useState("");
  const [keyAgent, setKeyAgent] = useState("");
  /** 新签发的明文,只在本次会话内显示一次 */
  const [issued, setIssued] = useState<{ id: string; plaintext: string } | null>(null);
  const [busy, setBusy] = useState<"issue" | string | null>(null);
  const [keysLoaded, setKeysLoaded] = useState(false);
  const [docAgentId, setDocAgentId] = useState("");
  const agentName = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const docAgent = agents.find((a) => a.id === docAgentId) ?? agents[0];

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
      fetchJson<{ agents?: AgentSummary[] }>("/api/agents"),
    ]);

    if (k.status === "fulfilled") setKeys(k.value.keys ?? []);
    else toast.error(`API Key 列表加载失败:${errorText(k.reason)}`);
    setKeysLoaded(true);

    if (a.status === "fulfilled") setAgents(a.value.agents ?? []);
    else toast.error(`智能体列表加载失败:${errorText(a.reason)}`);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function issueKey() {
    if (busy) return;
    setBusy("issue");
    try {
      const data = await fetchJson<{
        plaintext?: string;
        key?: { id?: string };
      }>("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: keyName.trim() || undefined,
          agentId: keyAgent || undefined,
        }),
      });
      if (!data.plaintext || !data.key?.id) throw new Error("接口没有返回新密钥");
      setIssued({ id: data.key.id, plaintext: data.plaintext });
      setKeyName("");
      await reload();
    } catch (error) {
      toast.error(`签发失败:${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  }

  async function revokeKey(id: string) {
    if (!window.confirm("确定吊销这把 API Key？正在使用它的系统会立即调用失败。")) return;
    if (busy) return;
    setBusy(id);
    try {
      await fetchJson(`/api/keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await reload();
      if (issued?.id === id) setIssued(null);
      toast.success("API Key 已吊销");
    } catch (error) {
      toast.error(`吊销失败:${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  }

  async function copyIssuedKey() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.plaintext);
      toast.success("API Key 已复制");
    } catch (error) {
      toast.error(`复制失败:${errorText(error)}`);
    }
  }

  return (
    <SpaceShell
      title="接入中心"
      subtitle="把智能体当接口用:签发 Key → 复制调用代码 → 接收回调或嵌入页面"
      width="narrow"
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">API Key</CardTitle>
          <CardDescription>
            从你的后端调用智能体时使用,不要放进浏览器。明文只在签发时显示一次,服务端只存哈希。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="用途备注,如「订单系统」"
            />
            <Select value={keyAgent} onChange={(e) => setKeyAgent(e.target.value)}>
              <option value="">不限智能体</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  仅 {a.name}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              className="shrink-0"
              onClick={() => void issueKey()}
              disabled={busy !== null}
            >
              {busy === "issue" ? "签发中…" : "签发"}
            </Button>
          </div>

          {issued && (
            <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3">
              <p className="font-medium text-xs">请立刻保存 —— 关闭后无法再次显示:</p>
              <code className="block break-all font-mono text-xs">{issued.plaintext}</code>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() => void copyIssuedKey()}
                >
                  <Copy className="size-3.5" />
                  复制
                </Button>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => setIssued(null)}
                >
                  我已保存
                </Button>
              </div>
            </div>
          )}

          <Separator />

          <div className="divide-y divide-border rounded border">
            {!keysLoaded && <p className="p-3 text-xs text-muted-foreground">载入中…</p>}
            {keysLoaded && keys.length === 0 && (
              <p className="p-3 text-xs text-muted-foreground">暂无 key</p>
            )}
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-3 p-2 text-xs">
                <span className="flex-1 truncate">
                  {k.name || "(未命名)"}
                  {k.agentId && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px]">
                      仅 {agentName.get(k.agentId) ?? k.agentId}
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
                  disabled={busy !== null}
                  onClick={() => void revokeKey(k.id)}
                >
                  吊销
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">接口文档与调用代码</CardTitle>
          <CardDescription>
            按智能体生成:入参示例来自它的输入契约(inputSchema),复制即可运行。 调用是异步的 —— 提交拿
            taskId,轮询结果或等 Webhook 回调。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {agents.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              还没有可调用的智能体,先去{" "}
              <Link href="/agents" className="underline">
                智能体
              </Link>{" "}
              建一个。
            </p>
          ) : (
            docAgent && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label="选择智能体"
                    value={docAgent.id}
                    onChange={(e) => setDocAgentId(e.target.value)}
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                  <Badge variant="secondary" className="text-[11px]">
                    {docAgent.config.inputSchema ? "结构化入参" : "文本入参"}
                  </Badge>
                  <Badge variant="secondary" className="text-[11px]">
                    {docAgent.config.outputSchema ? "结构化结果 structured" : "文本结果 text"}
                  </Badge>
                  <Button variant="link" size="sm" className="ml-auto h-8 px-2" asChild>
                    <a
                      href={`/api/agents/${encodeURIComponent(docAgent.id)}/openapi.json`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      OpenAPI 文档
                      <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                </div>
                <InvokeSnippetTabs
                  key={docAgent.id}
                  agentId={docAgent.id}
                  inputSchema={docAgent.config.inputSchema}
                  hasOutputSchema={Boolean(docAgent.config.outputSchema)}
                />
                <p className="text-xs text-muted-foreground">
                  结果回调:
                  {docAgent.canManageWebhook ? (
                    docAgent.webhookUrl ? (
                      <code className="mx-1 break-all">{docAgent.webhookUrl}</code>
                    ) : (
                      "未配置,"
                    )
                  ) : (
                    "由智能体所有者配置,"
                  )}
                  {docAgent.canWrite && (
                    <Link
                      href={`/agents?id=${encodeURIComponent(docAgent.id)}`}
                      className="underline"
                    >
                      在构建器里修改
                    </Link>
                  )}
                  。运行记录见{" "}
                  <Link href="/settings/runs" className="underline">
                    运行记录
                  </Link>
                  。
                </p>
              </>
            )
          )}
        </CardContent>
      </Card>

      <WebhookSecretCard />
    </SpaceShell>
  );
}
