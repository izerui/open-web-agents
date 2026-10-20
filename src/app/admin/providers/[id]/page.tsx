import { ProviderDetail } from "@/features/models/provider-detail";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { tab } = await searchParams;
  return <ProviderDetail id={id} initialTab={tab} />;
}
