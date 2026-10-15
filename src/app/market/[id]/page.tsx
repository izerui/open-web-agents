import { MarketDetail } from "@/features/market/market-detail";
import { requireLogin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireLogin();
  return <MarketDetail id={(await params).id} />;
}
