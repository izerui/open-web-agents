"use client";

// 只读视图(有读权限、没写权限):只读提示、脱敏后的配置 JSON、知识清单、克隆一份来改、在对话里使用。
// 克隆规则不变(只能克隆已上架且已发布的,取舍 3):不满足时按钮禁用并写明原因,可点时先确认再克隆。

import { AgentAvatar } from "@/components/agent-avatar";
import { useConfirm } from "@/components/confirm-dialog";
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
import { canCloneAgent } from "./build-model";
import { Banner, CodeBlock, Seg } from "./ui";
import type { BuildAgent } from "./use-build-data";

/** 克隆入口:能不能克隆、为什么不能、点了先确认 */
export function useClone(
  agent: {
    id: string;
    name: string;
    marketListed?: boolean;
    publishedVersion?: number | null;
  } | null,
) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const rule = agent ? canCloneAgent(agent) : { ok: false as const, reason: "" };
  return {
    busy,
    can: rule.ok,
    reason: rule.ok ? "" : rule.reason,
    dialog: confirm.dialog,
    clone: () => {
      if (!agent || !rule.ok) return;
      confirm.ask({
        title: `克隆「${agent.name}」？`,
        description:
          "按它当前的发布版复制一份到你名下（连同知识文档），成为你的新智能体草稿；配置里的密钥和回调地址不会带过来。",
        confirmLabel: "克隆",
        onConfirm: async () => {
          setBusy(true);
          try {
            const copy = await cloneAgent(agent.id);
            toast.success(`已克隆为「${copy.name}」`);
            router.push(agentHref({ id: copy.id }));
          } catch (e) {
            toast.error(`克隆失败：${errorText(e)}`);
          } finally {
            setBusy(false);
          }
        },
      });
    },
  };
}

/** 只读的智能体是怎么到你这里的(接口不暴露所有者账号,只说明来源) */
export function shareModeText(a: { id: string; isPublic?: boolean }): string {
  if (a.id === "default" || a.id === "agent-architect") return "平台内置";
  return a.isPublic ? "公开给所有账号" : "分享给你";
}

export function ReadonlyView({ agent }: { agent: BuildAgent }) {
  const [tab, setTab] = useState<"json" | "kb">("json");
  const clone = useClone(agent);
  const { publishedVersion } = agent;
  return (
    <div className="flex min-h-0 flex-1 gap-4 p-4 max-lg:flex-col max-lg:overflow-y-auto max-md:p-3">
      <div className="flex w-[380px] shrink-0 flex-col gap-3 max-lg:w-full">
        <div className="rounded-2xl border border-border bg-card px-5 py-[18px]">
          <div className="flex items-center gap-3">
            <AgentAvatar id={agent.id} icon={agent.icon} size={48} />
            <div className="min-w-0">
              <div className="truncate font-display text-xl font-bold">{agent.name}</div>
              <div className="text-[13px] text-muted-foreground">{shareModeText(agent)}，只读</div>
            </div>
          </div>
          {agent.description && (
            <p className="my-3 text-sm text-muted-foreground">{agent.description}</p>
          )}
          <dl className="m-0 mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-muted-foreground">所有者</dt>
            <dd className="m-0">
              {agent.id === "default" || agent.id === "agent-architect"
                ? "平台"
                : "另一个账号（不对你显示账号）"}
            </dd>
            <dt className="text-muted-foreground">分享方式</dt>
            <dd className="m-0">{shareModeText(agent)}，只读</dd>
          </dl>
          <Banner icon={<Lock />} className="mt-3 mb-3 text-[13px]">
            这是只读智能体，你可以查看配置和资料清单、直接使用，但不能修改。
            {clone.can ? "要改请联系所有者，或克隆一份来改。" : "要改请联系所有者。"}
          </Banner>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={clone.busy || !clone.can}
              title={clone.reason || undefined}
              onClick={clone.clone}
            >
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
          {!clone.can && (
            <p className="mt-2 mb-0 text-[13px] text-muted-foreground">{clone.reason}</p>
          )}
          {clone.dialog}
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
