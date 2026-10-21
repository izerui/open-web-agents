import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import type { VariableDef } from "@/lib/modules/agent/domain/config";
import type { McpDef } from "@/lib/shared";
import { openAgent } from "../_lib/agent-access";
import { mcpCheckRateLimited } from "../_lib/mcp-check-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 请求体里的 MCP 只取认识的字段,类型不对的交给配置校验报出来 */
function mcpOf(raw: unknown): McpDef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  return {
    name: typeof m.name === "string" ? m.name : "",
    type: m.type as McpDef["type"],
    ...(m.url !== undefined ? { url: m.url as string } : {}),
    ...(m.command !== undefined ? { command: m.command as string } : {}),
    ...(m.args !== undefined ? { args: m.args as string[] } : {}),
    ...(m.env !== undefined ? { env: m.env as Record<string, string> } : {}),
  };
}

/**
 * 构建器里的"测试连接":用当前填写的配置(不必先保存)握手并列出工具,不调用工具。
 * 带 agentId 时须对它有编辑权限,变量值取本人在它上面保存的;新建还没保存的智能体不带
 */
export async function POST(req: Request) {
  try {
    const { auth, mcpCheck } = getContainer();
    const principal = await auth.resolveWeb(req);
    auth.assertCanManageAgents(principal);
    const userId = (await auth.subjectOf(principal)).userId;
    const body = (await req.json().catch(() => null)) as {
      agentId?: unknown;
      server?: unknown;
      variables?: unknown;
    } | null;
    const def = mcpOf(body?.server);
    if (!def) return Response.json({ error: "server 必须是 MCP 配置对象" }, { status: 400 });
    let agentId: string | undefined;
    if (body?.agentId !== undefined && body.agentId !== null && body.agentId !== "") {
      if (typeof body.agentId !== "string") {
        return Response.json({ error: "agentId 无效" }, { status: 400 });
      }
      const opened = await openAgent(req, body.agentId, "write");
      if (!opened.ok) return opened.res;
      agentId = opened.agent.id;
    }
    const variables = Array.isArray(body?.variables)
      ? (body.variables as VariableDef[])
      : undefined;
    const limited = await mcpCheckRateLimited(userId);
    if (limited) return limited;
    const result = await mcpCheck.check({ def, variables, agentId, userId });
    return Response.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
