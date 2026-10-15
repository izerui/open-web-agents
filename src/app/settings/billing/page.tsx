import { BillingView } from "@/features/billing/billing-view";
import { requireLogin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireLogin();
  return <BillingView />;
}
