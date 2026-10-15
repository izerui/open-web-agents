import { CapabilityManager } from "@/features/capabilities/capability-manager";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin();
  return <CapabilityManager />;
}
