import { PackagesAdmin } from "@/features/admin/packages-admin";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

/** 套餐与订单:套餐目录(版本化)+ 订单人工确认(?tab=orders) */
export default async function Page() {
  await requireAdmin();
  return <PackagesAdmin />;
}
