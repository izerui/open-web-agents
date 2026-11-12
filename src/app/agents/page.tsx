import { StudioView } from "@/features/studio/studio-view";
import { type PageSearchParams, toSearchParams } from "@/lib/nav/legacy-page";
import { legacyRedirect } from "@/lib/nav/routes";
import { requireLogin } from "@/lib/server-guard";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** 工作室 · 我的智能体 */
export default async function Page({ searchParams }: { searchParams: PageSearchParams }) {
  // 旧的 /agents?id= 与 /agents?new=1
  const target = legacyRedirect("/agents", await toSearchParams(searchParams));
  if (target) redirect(target);
  await requireLogin();
  return <StudioView />;
}
