import { MarketView } from "@/features/market/market-view";
import { type PageSearchParams, toSearchParams } from "@/lib/nav/legacy-page";
import { legacyRedirect } from "@/lib/nav/routes";
import { requireLogin } from "@/lib/server-guard";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * 首页 = 探索(coze-v3 信息架构)。阶段 1 先渲染市场,阶段 2 换成探索页。
 * 旧的 /?session= / /?agent= 是工作台地址,对话已搬到 /chat。
 */
export default async function Home({ searchParams }: { searchParams: PageSearchParams }) {
  const target = legacyRedirect("/", await toSearchParams(searchParams));
  if (target) redirect(target);
  await requireLogin();
  return <MarketView />;
}
