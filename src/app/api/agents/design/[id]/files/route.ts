import { uploadToWorkspace } from "@/app/api/_lib/workspace-upload";
import { getContainer } from "@/lib/container";
import { DRAFT_FILE } from "@/lib/modules/agent/domain/design";
import { designCaller, designError } from "../../_lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 设计器附件:把业务文档传进设计会话的工作目录,发消息时在提示词末尾列出文件名(与对话页一致),
 * 设计器据此读取。只能往自己的设计会话传;限制与对话页相同(单个 10MB、一次 20 个、只新建不覆盖);
 * 设计草稿文件名保留给设计器。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { subject } = await designCaller(req);
    const { designer, sessions, storage } = getContainer();
    const target = await designer.workspaceOf(subject, (await params).id);
    return await uploadToWorkspace(req, target, { sessions, storage }, { reserved: [DRAFT_FILE] });
  } catch (err) {
    return designError(err);
  }
}
