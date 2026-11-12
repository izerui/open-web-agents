"use client";

import { AgentAvatar } from "@/components/agent-avatar";
import { notifyAgentCatalogChanged } from "@/components/ide/agent-catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KnowledgePanel } from "@/features/builder/knowledge-panel";
import { errorText, fetchJson } from "@/lib/fetch-json";
import { agentHref } from "@/lib/nav/routes";
import { Copy, Eye, Lock, MessageSquare } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { chatHref } from "./agent-card";
import type { StudioAgent } from "./studio-model";

/**
 * 克隆一个已上架的智能体到自己名下(与市场「克隆到我的智能体」同一个接口、同一套规则:
 * 只能克隆已上架且已发布的,克隆的是发布版配置)。成功后进入它的构建页。
 */
export async function cloneAgent(id: string): Promise<{ id: string; name: string }> {
  const result = await fetchJson<{ agent: { id: string; name: string } }>(
    `/api/agents/${encodeURIComponent(id)}/clone`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  notifyAgentCatalogChanged();
  return result.agent;
}

/** 只读智能体:脱敏配置、知识清单、对话、克隆一份来改 */
export function ReadonlyDrawer({
  agent,
  onOpenChangeAction,
}: {
  agent: StudioAgent | null;
  onOpenChangeAction: (open: boolean) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const cloneable = agent?.marketListed === true && !!agent.publishedVersion;

  async function clone() {
    if (!agent || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const copy = await cloneAgent(agent.id);
      toast.success(`已克隆为「${copy.name}」`);
      router.push(agentHref({ id: copy.id }));
    } catch (e) {
      toast.error(`克隆失败：${errorText(e)}`);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <Sheet open={!!agent} onOpenChange={onOpenChangeAction}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-[560px]">
        {agent && (
          <>
            <div className="flex items-center gap-3 border-b border-line-soft py-4 pr-14 pl-[22px]">
              <AgentAvatar id={agent.id} icon={agent.icon} size={36} />
              <div className="min-w-0">
                <SheetTitle className="truncate font-sans text-base font-semibold">
                  {agent.name}
                </SheetTitle>
                <SheetDescription className="truncate font-mono text-xs">
                  {agent.id}
                </SheetDescription>
              </div>
              <Badge variant="outline" className="ml-auto">
                <Eye aria-hidden="true" />
                只读
              </Badge>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-[22px] py-5">
              <div className="mb-4 flex gap-2.5 rounded-xl bg-[#F2F1EC] px-3.5 py-3 text-sm text-[#3C3A35]">
                <Lock className="mt-0.5 size-[18px] shrink-0" aria-hidden="true" />
                <p>
                  这是只读智能体：所有者给了你只读权限。你可以查看配置和知识清单、直接对话使用发布版，不能修改。需要修改请联系所有者
                  {cloneable ? "，或者克隆一份来改" : ""}。
                </p>
              </div>
              <Tabs defaultValue="config">
                <TabsList aria-label="只读智能体内容">
                  <TabsTrigger value="config">配置</TabsTrigger>
                  <TabsTrigger value="knowledge">知识</TabsTrigger>
                </TabsList>
                <TabsContent value="config" className="pt-3">
                  <p className="mb-2 text-xs text-muted-foreground">
                    脱敏后的配置 JSON，密钥类变量不显示明文。
                  </p>
                  <pre className="overflow-x-auto rounded-xl bg-[#1F1E1C] px-4 py-3.5 font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap text-[#EAE6DC]">
                    {JSON.stringify(agent.config, null, 2)}
                  </pre>
                </TabsContent>
                <TabsContent value="knowledge" className="pt-3">
                  <p className="mb-2 text-xs text-muted-foreground">只读，不能新增或删除资料。</p>
                  <KnowledgePanel agentId={agent.id} canWrite={false} />
                </TabsContent>
              </Tabs>
            </div>
            <div className="flex flex-wrap items-center gap-2.5 border-t border-line-soft px-[22px] py-3.5">
              <Button asChild variant="outline" className="max-md:h-11">
                <Link href={chatHref(agent.id)}>
                  <MessageSquare />
                  对话
                </Link>
              </Button>
              <div className="ml-auto flex flex-col items-end gap-1">
                <Button
                  disabled={!cloneable || busy}
                  onClick={() => void clone()}
                  className="max-md:h-11"
                >
                  <Copy />
                  {busy ? "正在克隆…" : "克隆一份来改"}
                </Button>
                {!cloneable && (
                  <span className="text-xs text-muted-foreground">
                    只有已上架市场的智能体可以克隆
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
