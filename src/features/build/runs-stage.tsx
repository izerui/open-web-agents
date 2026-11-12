"use client";

// 运行阶段:顶部 7 天小统计(A17,用量接口按智能体过滤;与页头「运行」徽标同一份数据)+
// 本智能体的运行列表、详情抽屉与取消运行(复用 RunsPanel)。

import { creditsText } from "@/features/models/model-shared";
import { type AgentList, RunsPanel } from "@/features/runs/runs-view";
import Link from "next/link";
import type { runStats } from "./build-model";
import { Banner, StageTitle } from "./ui";

export function RunsStage({
  agentId,
  agentList,
  stats,
  error,
}: {
  agentId: string | null;
  agentList: AgentList;
  stats: ReturnType<typeof runStats> | null;
  error: boolean;
}) {
  if (!agentId) {
    return (
      <div>
        <StageTitle title="运行" />
        <Banner>草稿建好、跑过一次之后，这里会出现运行记录。</Banner>
      </div>
    );
  }

  const cell = (label: string, value: string) => (
    <div className="rounded-2xl border border-border bg-card px-[18px] py-4">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="font-display text-[26px] font-semibold">{value}</div>
    </div>
  );

  return (
    <div>
      <StageTitle
        title="运行"
        desc="本智能体的运行，包括对话、试聊、API 会话、接口调用、评测与智能体设计器；计费在你名下的才显示。"
        right={
          <Link href="/developer/runs" className="text-[13px] underline">
            全部智能体的运行记录
          </Link>
        }
      />
      <div className="mb-4 grid grid-cols-3 gap-3 max-md:grid-cols-1">
        {cell("近 7 天调用", stats ? String(stats.runs) : error ? "—" : "…")}
        {cell("失败率", stats ? stats.failRate : error ? "—" : "…")}
        {cell("消耗积分（估算）", stats ? creditsText(stats.microCredits) : error ? "—" : "…")}
      </div>
      <RunsPanel requestedAgent={agentId} platform={false} agentList={agentList} />
    </div>
  );
}
