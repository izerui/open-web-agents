"use client";

// 只读视图(有读权限、没写权限):只读提示、脱敏后的配置 JSON、知识清单、克隆一份来改、在对话里使用。

import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { KnowledgePanel } from "@/features/builder/knowledge-panel";
import { cloneAgent } from "@/features/studio/readonly-drawer";
import { errorText } from "@/lib/fetch-json";
import { agentHref } from "@/lib/nav/routes";
import { Copy, Lock, MessageSquare } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Banner, CodeBlock, Seg } from "./ui";
import type { BuildAgent } from "./use-build-data";

export function useClone(agentId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    clone: async () => {
      setBusy(true);
      try {
        const copy = await cloneAgent(agentId);
        toast.success(`已克隆为「${copy.name}」`);
        router.push(agentHref({ id: copy.id }));
      } catch (e) {
        toast.error(`克隆失败：${errorText(e)}`);
      } finally {
        setBusy(false);
      }
    },
  };
}

export function ReadonlyView({ agent }: { agent: BuildAgent }) {
  const [tab, setTab] = useState<"json" | "kb">("json");
  const { busy, clone } = useClone(agent.id);
  const { publishedVersion, isPublic } = agent;
  return (
    <div className="flex min-h-0 flex-1 gap-4 p-4 max-lg:flex-col max-lg:overflow-y-auto max-md:p-3">
      <div className="flex w-[380px] shrink-0 flex-col gap-3 max-lg:w-full">
        <div className="rounded-2xl border border-border bg-card px-5 py-[18px]">
          <div className="flex items-center gap-3">
            <AgentAvatar id={agent.id} icon={agent.icon} size={48} />
            <div className="min-w-0">
              <div className="truncate font-display text-xl font-bold">{agent.name}</div>
              <div className="text-[13px] text-muted-foreground">
                {isPublic ? "公开给所有账号，只读" : "分享给你，只读"}
              </div>
            </div>
          </div>
          {agent.description && (
            <p className="my-3 text-sm text-muted-foreground">{agent.description}</p>
          )}
          <Banner icon={<Lock />} className="mt-3 mb-3 text-[13px]">
            这是只读智能体，你可以查看配置和资料清单、直接使用，但不能修改。要改请联系所有者，或克隆一份来改。
          </Banner>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void clone()}>
              <Copy />
              克隆一份来改
            </Button>
            <Button variant="outline" asChild>
              <Link href={`/chat?agent=${encodeURIComponent(agent.id)}`}>
                <MessageSquare />
                在对话里使用
              </Link>
            </Button>
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-card px-5 py-[18px] text-sm">
          <div className="text-[13px] text-muted-foreground">发布状态</div>
          <div className="mt-1">{publishedVersion ? `已发布 v${publishedVersion}` : "未发布"}</div>
          <div className="mt-2.5 text-[13px] text-muted-foreground">你能用的版本</div>
          <div className="mt-1">
            {publishedVersion ? `发布版 v${publishedVersion}（作者没发布的修改你看不到）` : "草稿"}
          </div>
        </div>
      </div>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] border border-border bg-card max-lg:min-h-[480px]">
        <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-[18px] py-3">
          <Seg
            ariaLabel="只读视图"
            options={[
              ["json", "配置"],
              ["kb", "知识"],
            ]}
            value={tab}
            onChange={setTab}
          />
          <span className="text-[13px] text-muted-foreground">
            {tab === "json" ? "脱敏后的配置，密钥与回调地址不显示" : "可以看资料清单，但不能增删"}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-5 max-md:px-4">
          {tab === "json" ? (
            <CodeBlock className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              {JSON.stringify(
                { name: agent.name, id: agent.id, description: agent.description, ...agent.config },
                null,
                2,
              )}
            </CodeBlock>
          ) : (
            <KnowledgePanel agentId={agent.id} canWrite={false} />
          )}
        </div>
      </section>
    </div>
  );
}
