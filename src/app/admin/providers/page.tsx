import { ProviderList } from "@/features/models/provider-list";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin();
  return <ProviderList />;
}
