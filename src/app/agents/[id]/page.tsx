import { Builder } from "@/features/builder/builder";
import { DesignWorkspace } from "@/features/builder/design-workspace";
import { AccessCenterView } from "@/features/integration/access-center-view";
import { RunsView } from "@/features/runs/runs-view";
import { requireLogin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

/**
 * 构建页。阶段 1 按 ?stage 复用现有视图:接入 → 接入中心(单智能体),运行 → 运行记录(单智能体),
 * 带 ?designer=<设计会话> 时是智能体设计器,其余由 Builder 渲染(它从路径读出智能体)。
 * 阶段 5 这些合成一页的五个阶段。
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ designer?: string; stage?: string }>;
}) {
  await requireLogin();
  const raw = (await params).id;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // 已经是解码后的值(含字面 %)时原样使用
  }
  const { designer, stage } = await searchParams;
  if (designer) return <DesignWorkspace initialSessionId={designer} />;
  if (stage === "access") return <AccessCenterView agentId={id} />;
  if (stage === "runs") return <RunsView agentId={id} />;
  return <Builder />;
}
