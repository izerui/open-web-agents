import { UsageView } from "@/features/usage/usage-view";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin();
  return <UsageView scope="all" />;
}
