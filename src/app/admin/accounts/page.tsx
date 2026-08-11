import { AccountsView } from "@/features/admin/accounts-view";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin();
  return <AccountsView />;
}
