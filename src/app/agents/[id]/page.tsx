import { stageFromParam } from "@/features/build/build-model";
import { BuildPage } from "@/features/build/build-page";
import { stageOfLegacyTab } from "@/lib/nav/routes";
import { requireLogin } from "@/lib/server-guard";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * 构建页:一页五个阶段(?stage=eval|publish|access|runs,默认编排);?designer=<设计会话> 打开指定设计记录。
 * 旧 Builder 的 ?tab= 分区换成对应阶段(评测、发布各有阶段,其余分区都在编排里)。
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireLogin();
  const raw = (await params).id;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // 已经是解码后的值(含字面 %)时原样使用
  }
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const tab = one(sp.tab);
  if (tab !== undefined) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      const s = one(v);
      if (k !== "tab" && s !== undefined) q.set(k, s);
    }
    const stage = stageOfLegacyTab(tab);
    if (stage) q.set("stage", stage);
    else if (stage === null) q.delete("stage");
    const s = q.toString();
    redirect(`/agents/${encodeURIComponent(id)}${s ? `?${s}` : ""}`);
  }
  return (
    <BuildPage
      key={id}
      agentId={id}
      designerSession={one(sp.designer)}
      initialStage={stageFromParam(one(sp.stage))}
    />
  );
}
