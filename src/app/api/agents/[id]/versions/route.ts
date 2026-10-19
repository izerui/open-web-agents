import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { NothingToPublish } from "@/lib/modules/agent/application/releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 版本列表 + 发布状态。能看到这个智能体的人都能看(不含配置内容)。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openAgent(req, id, "read");
  if (!opened.ok) return opened.res;
  const { releases } = getContainer();
  return Response.json({
    publishedVersion: opened.agent.publishedVersion ?? null,
    // 草稿是否改过只对能改的人有意义;只读者看到的始终是已发布版本
    hasUnpublishedChanges: opened.canWrite
      ? releases.hasUnpublishedChanges(opened.agent)
      : undefined,
    versions: await releases.list(id),
  });
}

/**
 * 发布:把当前草稿冻结成新版本,接口调用与 API 会话从此跑这一版。
 * 草稿与已发布完全相同时 409,避免产生内容重复的版本。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openAgent(req, id, "write");
  if (!opened.ok) return opened.res;
  const body = (await req.json().catch(() => ({}))) as { note?: unknown };
  if (body.note !== undefined && typeof body.note !== "string") {
    return apiError(400, "invalid_request", "note 必须是字符串");
  }
  try {
    const v = await getContainer().releases.publish(
      opened.agent,
      opened.subject.userId,
      body.note as string | undefined,
    );
    const { config: _config, ...meta } = v;
    await getContainer().audit.record({
      actor: opened.principal,
      action: "agent.publish",
      resource: { type: "agent", id },
      ownerId: opened.agent.ownerId,
      details: {
        version: v.version,
        previousVersion: opened.agent.publishedVersion ?? null,
        note: v.note,
      },
      req,
    });
    return Response.json({ version: meta }, { status: 201 });
  } catch (err) {
    if (err instanceof NothingToPublish) {
      return apiError(409, "nothing_to_publish", err.message, { version: err.version });
    }
    throw err;
  }
}
