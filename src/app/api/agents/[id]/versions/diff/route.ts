import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { redactAgentConfigForReader } from "@/lib/modules/agent/domain/config";
import { parseVersion, snapshotOf } from "@/lib/modules/agent/domain/release";
import { diffSnapshots } from "@/lib/modules/agent/domain/snapshot-diff";
import type { AgentSnapshot } from "@/lib/modules/agent/ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 两个版本之间(或某个版本与当前草稿之间)改了什么:?from=1&to=2,to / from 可以是 draft。
 * 发布、回滚之前用它确认差异。只读者看到的配置同样脱敏(MCP 环境变量、逃生舱),两边一起脱敏。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openAgent(req, id, "read");
  if (!opened.ok) return opened.res;

  const url = new URL(req.url);
  const pick = async (
    raw: string | null,
  ): Promise<{ ok: true; snap: AgentSnapshot } | { ok: false; res: Response }> => {
    if (raw === "draft") return { ok: true, snap: snapshotOf(opened.agent) };
    const n = parseVersion(raw ?? undefined);
    if (!n.ok || n.value === undefined) {
      return {
        ok: false,
        res: apiError(400, "invalid_request", "from / to 须为正整数版本号或 draft"),
      };
    }
    const v = await getContainer().releases.get(id, n.value);
    if (!v) return { ok: false, res: apiError(404, "not_found", `version ${n.value} not found`) };
    return {
      ok: true,
      snap: { name: v.name, icon: v.icon, description: v.description, config: v.config },
    };
  };

  const from = await pick(url.searchParams.get("from"));
  if (!from.ok) return from.res;
  const to = await pick(url.searchParams.get("to"));
  if (!to.ok) return to.res;

  const view = (s: AgentSnapshot): AgentSnapshot =>
    opened.canWrite ? s : { ...s, config: redactAgentConfigForReader(s.config) };
  return Response.json({
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    changes: diffSnapshots(view(from.snap), view(to.snap)),
  });
}
