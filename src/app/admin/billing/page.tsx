import { BillingAdmin } from "@/features/admin/billing-admin";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin();
  return <BillingAdmin />;
}
