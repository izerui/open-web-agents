import { RunsView } from "@/features/runs/runs-view";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin();
  return <RunsView platform />;
}
