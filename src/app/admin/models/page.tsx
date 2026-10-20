import { ModelOverview } from "@/features/models/model-overview";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin();
  return <ModelOverview />;
}
