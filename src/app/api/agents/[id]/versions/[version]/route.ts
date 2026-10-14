import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { redactAgentConfigForReader } from "@/lib/modules/agent/domain/config";
import { parseVersion } from "@/lib/modules/agent/domain/release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 某个版本的完整内容。只读者看到的配置同样脱敏(MCP 环境变量、逃生舱)。 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; version: string }> },
) {
  const { id, version } = await params;
  const opened = await openAgent(req, id, "read");
  if (!opened.ok) return opened.res;
  const n = parseVersion(version);
  if (!n.ok || n.value === undefined) return apiError(400, "invalid_request", "版本号须为正整数");
  const v = await getContainer().releases.get(id, n.value);
  if (!v) return apiError(404, "not_found", "version not found");
  return Response.json({
    version: {
      ...v,
      config: opened.canWrite ? v.config : redactAgentConfigForReader(v.config),
    },
  });
}
