import { DeveloperKeysView } from "@/features/integration/developer-keys-view";
import { type PageSearchParams, toSearchParams } from "@/lib/nav/legacy-page";
import { legacyRedirect } from "@/lib/nav/routes";
import { requireLogin } from "@/lib/server-guard";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: PageSearchParams }) {
  // 旧的 /developer/keys?agent=x:单个智能体的接入在它的构建页
  const target = legacyRedirect("/developer/keys", await toSearchParams(searchParams));
  if (target) redirect(target);
  await requireLogin();
  return <DeveloperKeysView />;
}
