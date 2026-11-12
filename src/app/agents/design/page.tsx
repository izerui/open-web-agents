import { DesignWorkspace } from "@/features/builder/design-workspace";
import { getContainer } from "@/lib/container";
import { agentHref } from "@/lib/nav/routes";
import { requireLogin } from "@/lib/server-guard";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * 旧地址:智能体设计器(原「AI 编辑」)已并入构建页。
 * 有目标智能体的设计会话落到 /agents/<id>?designer=,否则落到 /agents/new?designer=;
 * 查不到或无权查看时同样落到 /agents/new,由设计器页面显示它原有的错误态。
 */
export default async function Page({
  searchParams,
}: { searchParams: Promise<{ session?: string }> }) {
  await requireLogin();
  const { session } = await searchParams;
  // 不带会话:和以前一样直接打开智能体设计器,从零开始一个新设计
  if (!session) return <DesignWorkspace />;
  let targetId: string | undefined;
  try {
    const { auth, designer } = getContainer();
    const h = await headers();
    const req = new Request("http://internal/", { headers: { cookie: h.get("cookie") ?? "" } });
    const principal = await auth.resolveWeb(req);
    targetId = (await designer.inspect(await auth.subjectOf(principal), session)).targetId;
  } catch {
    targetId = undefined;
  }
  const base = targetId ? agentHref({ id: targetId }) : agentHref({ isNew: true });
  redirect(`${base}?designer=${encodeURIComponent(session)}`);
}
