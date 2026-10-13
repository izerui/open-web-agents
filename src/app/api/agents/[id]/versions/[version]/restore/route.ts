import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { escapeHatchChangeDenied } from "@/app/api/agents/_lib/escape-hatch-guard";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { parseVersion } from "@/lib/modules/agent/domain/release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 载入草稿:把这个版本的内容放回草稿,在它基础上继续改。不影响已发布的版本。 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; version: string }> },
) {
  const { id, version } = await params;
  const opened = await openAgent(req, id, "write");
  if (!opened.ok) return opened.res;
  const n = parseVersion(version);
  if (!n.ok || n.value === undefined) return apiError(400, "invalid_request", "版本号须为正整数");

  const { releases } = getContainer();
  const target = await releases.get(id, n.value);
  if (!target) return apiError(404, "not_found", "version not found");
  const denied = escapeHatchChangeDenied(
    opened.subject,
    opened.agent.config.escapeHatch,
    target.config.escapeHatch,
  );
  if (denied) return denied;

  const agent = await releases.restoreToDraft(opened.agent, n.value);
  return Response.json({ agent });
}
