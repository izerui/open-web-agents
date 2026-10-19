import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { escapeHatchChangeDenied } from "@/app/api/agents/_lib/escape-hatch-guard";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { parseVersion } from "@/lib/modules/agent/domain/release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 回滚(或前滚):把发布指针指向这个版本。之后新建的接口调用与 API 会话跑它;
 * 已经建好的会话仍按各自锁定的版本跑完。
 */
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
  const current = opened.agent.publishedVersion
    ? await releases.get(id, opened.agent.publishedVersion)
    : null;
  const denied = escapeHatchChangeDenied(
    opened.subject,
    (current?.config ?? opened.agent.config).escapeHatch,
    target.config.escapeHatch,
  );
  if (denied) return denied;

  await releases.activate(id, n.value);
  await getContainer().audit.record({
    actor: opened.principal,
    action: "agent.activate_version",
    resource: { type: "agent", id },
    ownerId: opened.agent.ownerId,
    details: { from: opened.agent.publishedVersion ?? null, to: n.value },
    req,
  });
  return Response.json({ publishedVersion: n.value });
}
