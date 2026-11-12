import { ModelsPage } from "@/features/admin/models-page";
import { requireAdmin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

/** 模型与提供者:提供者 / 模型总览 / 默认路由(?tab=) */
export default async function Page() {
  await requireAdmin();
  return <ModelsPage />;
}
