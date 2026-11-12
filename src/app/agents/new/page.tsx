import { BuildPage } from "@/features/build/build-page";
import { NEW_MODES, type NewMode } from "@/features/studio/studio-model";
import { StudioView } from "@/features/studio/studio-view";
import { requireLogin } from "@/lib/server-guard";

export const dynamic = "force-dynamic";

/**
 * 新建智能体:工作室页面上自动打开新建弹层(?mode= 选方式,?desc= 预填设计器描述)。
 * 带 ?designer=<设计会话> 时是构建页的新建态:智能体设计器从零创建,desc 预填进它的输入框(不自动发送)。
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ designer?: string; desc?: string; mode?: string }>;
}) {
  await requireLogin();
  const { designer, desc, mode } = await searchParams;
  if (designer) {
    return (
      <BuildPage
        key={`new:${designer}`}
        designerSession={designer}
        initialDesc={desc}
        initialStage="orch"
      />
    );
  }
  const initialMode = NEW_MODES.includes(mode as NewMode) ? (mode as NewMode) : "ai";
  return <StudioView initialNew initialMode={initialMode} initialDesc={desc ?? ""} />;
}
