import { AccountSecurityView } from "@/features/settings/account-security-view";
import { requireLogin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireLogin();
  return <AccountSecurityView />;
}
