import { DesignWorkspace } from "@/features/builder/design-workspace";
import { requireLogin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI 编辑 · Open Web Agents" };

export default async function Page({
  searchParams,
}: { searchParams: Promise<{ session?: string }> }) {
  await requireLogin();
  return <DesignWorkspace initialSessionId={(await searchParams).session} />;
}
