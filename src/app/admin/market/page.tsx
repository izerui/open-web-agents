import { MarketView } from "@/features/market/market-view";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin();
  return <MarketView manageOnly />;
}
