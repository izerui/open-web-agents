import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { agentAccessLevel, canInvokeAgent } from "@/lib/modules/access/domain/principal";
import { VariableSizeExceeded } from "@/lib/modules/agent/adapters/mysql-variable-repo";
import type { VariableDef } from "@/lib/modules/agent/domain/config";
import { isSystemAgent } from "@/lib/modules/agent/domain/system-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { agents, auth, grants, variables, releases, sessions } = getContainer();
    const principal = await auth.resolveWeb(req);
    const subject = await auth.subjectOf(principal);
    const { id } = await params;

    if (isSystemAgent(id)) return Response.json({ error: "not found" }, { status: 404 });
    const agent = await agents.get(id);
    if (!agent) return Response.json({ error: "not found" }, { status: 404 });

    const grantList = await grants.listForResource("agent", id);
    const level = agentAccessLevel(principal, agent, subject, grantList);
    const canUse = canInvokeAgent(principal, agent, subject, grantList);
    if (level === "none" && !canUse.allowed) {
      return Response.json({ error: "no access" }, { status: 403 });
    }

    const query = new URL(req.url).searchParams;
    const versionParam = query.get("version");
    const sessionParam = query.get("sessionId");

    let defs: VariableDef[];
    if (sessionParam) {
      const session = await sessions.get(sessionParam);
      if (!session || session.agentId !== id) {
        return Response.json({ error: "会话不存在或不属于此智能体" }, { status: 404 });
      }
      if (session.agentVersion != null) {
        const ver = await releases.get(id, session.agentVersion);
        defs = ver?.config.variables ?? [];
      } else {
        defs = agent.config.variables ?? [];
      }
    } else if (versionParam !== null) {
      const v = Number(versionParam);
      if (!Number.isInteger(v) || v < 1) {
        return Response.json({ error: "version 须为正整数" }, { status: 400 });
      }
      const ver = await releases.get(id, v);
      defs = ver?.config.variables ?? [];
    } else if (level === "write") {
      defs = agent.config.variables ?? [];
    } else {
      const release =
        agent.publishedVersion != null ? await releases.get(id, agent.publishedVersion) : null;
      defs = release?.config.variables ?? agent.config.variables ?? [];
    }

    const raw = await variables.get(id, subject.userId);
    const values: Record<string, string> = {};
    for (const def of defs) {
      const val = raw[def.name];
      if (val === undefined) continue;
      values[def.name] = def.secret ? "***" : val;
    }

    return Response.json(
      { variables: defs, values, filled: Object.keys(raw).length > 0 },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { agents, auth, grants, variables } = getContainer();
    const principal = await auth.resolveWeb(req);
    if (principal.type !== "web")
      return Response.json({ error: "API Key 无权设置变量" }, { status: 403 });
    const subject = await auth.subjectOf(principal);
    const { id } = await params;

    if (isSystemAgent(id)) return Response.json({ error: "not found" }, { status: 404 });
    const agent = await agents.get(id);
    if (!agent) return Response.json({ error: "not found" }, { status: 404 });

    const grantList = await grants.listForResource("agent", id);
    const level = agentAccessLevel(principal, agent, subject, grantList);
    const canUse = canInvokeAgent(principal, agent, subject, grantList);
    if (level === "none" && !canUse.allowed) {
      return Response.json({ error: "no access" }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "请提供变量值对象" }, { status: 400 });
    }

    const updates: Record<string, string | null> = {};

    for (const [key, val] of Object.entries(body)) {
      if (typeof val !== "string") {
        return Response.json({ error: `变量 ${key} 的值须为字符串` }, { status: 400 });
      }
      if (val.length > 4000) {
        return Response.json({ error: `变量 ${key} 的值不能超过 4000 字符` }, { status: 400 });
      }
      if (val === "***") continue;
      updates[key] = val.trim() ? val : null;
    }

    await variables.merge(id, subject.userId, updates);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof VariableSizeExceeded) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
}
