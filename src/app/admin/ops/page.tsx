import { OpsPage } from "@/features/admin/ops-page";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin();
  return <OpsPage />;
}
