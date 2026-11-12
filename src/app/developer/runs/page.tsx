import { DeveloperRunsView } from "@/features/runs/runs-view";
import { type PageSearchParams, toSearchParams } from "@/lib/nav/legacy-page";
import { legacyRedirect } from "@/lib/nav/routes";
import { requireLogin } from "@/lib/server-guard";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: PageSearchParams }) {
  // 旧的 /developer/runs?agent=x:单个智能体的运行在它的构建页
  const target = legacyRedirect("/developer/runs", await toSearchParams(searchParams));
  if (target) redirect(target);
  await requireLogin();
  return <DeveloperRunsView />;
}
