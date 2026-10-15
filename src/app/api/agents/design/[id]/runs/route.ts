import { getContainer } from "@/lib/container";
import { DESIGN_EXECUTOR_ID } from "@/lib/modules/agent/domain/system-agent";
import { designCaller, designError } from "../../_lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEXT_LIMIT = 2000;
const STRUCTURED_LIMIT = 1000;

function truncate(text: string | undefined | null, limit: number): string | undefined {
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { subject } = await designCaller(req);
    const { sessions, runQuery } = getContainer();
    const { id } = await params;

    const session = await sessions.get(id);
    if (
      !session ||
      session.source !== "design" ||
      session.status === "deleted" ||
      session.ownerId !== subject.userId ||
      session.agentId !== DESIGN_EXECUTOR_ID
    ) {
      return designError(new Error("设计会话不存在"));
    }

    const targetAgentId = session.designTargetAgentId;
    if (!targetAgentId) {
      return Response.json({ runs: [] }, { headers: { "Cache-Control": "no-store" } });
    }

    const result = await runQuery.list({
      agentId: targetAgentId,
      statuses: ["success", "failed", "cancelled"],
      limit: 10,
    });

    const runs = await Promise.all(
      result.items.map(async (item) => {
        const detail = await runQuery.detail(item.id);
        return {
          runId: item.id,
          status: item.status,
          promptPreview: item.promptPreview,
          text: truncate(detail?.finalText, TEXT_LIMIT),
          structured: detail?.structured
            ? truncate(JSON.stringify(detail.structured), STRUCTURED_LIMIT)
            : undefined,
          error: item.error,
          at: item.createdAt,
        };
      }),
    );

    return Response.json({ runs }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return designError(err);
  }
}
