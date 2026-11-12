import { UsageView } from "@/features/usage/usage-view";
import { requireLogin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireLogin();
  return <UsageView scope="self" />;
}
