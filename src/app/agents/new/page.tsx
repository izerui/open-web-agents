import { Builder } from "@/features/builder/builder";
import { DesignWorkspace } from "@/features/builder/design-workspace";
import { requireLogin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

/** 新建智能体;带 ?designer=<设计会话> 时是智能体设计器从零创建 */
export default async function Page({
  searchParams,
}: { searchParams: Promise<{ designer?: string }> }) {
  await requireLogin();
  const { designer } = await searchParams;
  return designer ? <DesignWorkspace initialSessionId={designer} /> : <Builder />;
}
