import { MeView } from "@/features/me/me-view";
import { requireLogin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

/** 「我的」聚合页:手机底部标签栏的入口(桌面上也能打开,归在账户空间下)。 */
export default async function Page() {
  await requireLogin();
  return <MeView />;
}
