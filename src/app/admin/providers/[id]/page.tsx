import { type PageSearchParams, redirectLegacy } from "@/lib/nav/legacy-page";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

/** 旧地址,已迁到 /admin/models/providers/<id>(见 src/lib/nav/routes.ts) */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: PageSearchParams;
}) {
  await requireAdmin();
  const { id } = await params;
  return redirectLegacy(`/admin/providers/${encodeURIComponent(id)}`, searchParams);
}
