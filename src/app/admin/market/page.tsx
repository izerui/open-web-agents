import { MarketAdmin } from "@/features/admin/market-admin";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

/** 市场上架:已发布智能体的上下架与类别 + 上架申请审核(?tab=requests) */
export default async function Page() {
  await requireAdmin();
  return <MarketAdmin />;
}
