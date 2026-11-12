import { ExploreView } from "@/features/explore/explore-view";
import { type PageSearchParams, toSearchParams } from "@/lib/nav/legacy-page";
import { legacyRedirect } from "@/lib/nav/routes";
import { requireLogin } from "@/lib/server-guard";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * 首页 = 探索(coze-v3 信息架构):说一件事、最近会话、市场。
 * 旧的 /?session= / /?agent= 是工作台地址,对话已搬到 /chat。
 */
export default async function Home({ searchParams }: { searchParams: PageSearchParams }) {
  const target = legacyRedirect("/", await toSearchParams(searchParams));
  if (target) redirect(target);
  await requireLogin();
  return <ExploreView />;
}
