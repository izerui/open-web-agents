import { type PageSearchParams, redirectLegacy } from "@/lib/nav/legacy-page";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

/** 旧地址,已并入 /admin/ops?tab=runs(见 src/lib/nav/routes.ts);先守卫,普通账号直接被挡回 */
export default async function Page({ searchParams }: { searchParams: PageSearchParams }) {
  await requireAdmin();
  return redirectLegacy("/admin/runs", searchParams);
}
