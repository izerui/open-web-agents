import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { agentAccessLevel, canInvokeAgent } from "@/lib/modules/access/domain/principal";
import type { VariableDef } from "@/lib/modules/agent/domain/config";
import { isSystemAgent } from "@/lib/modules/agent/domain/system-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mergeVariableDefs(...sources: (VariableDef[] | undefined)[]): VariableDef[] {
  const byName = new Map<string, VariableDef>();
  for (const defs of sources) {
    for (const d of defs ?? []) {
      if (!byName.has(d.name)) byName.set(d.name, d);
    }
  }
  return [...byName.values()];
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { agents, auth, grants, variables, releases } = getContainer();
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

    const release =
      agent.publishedVersion != null ? await releases.get(id, agent.publishedVersion) : null;

    const defs: VariableDef[] =
      level === "write"
        ? mergeVariableDefs(agent.config.variables, release?.config.variables)
        : (release?.config.variables ?? agent.config.variables ?? []);

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
    const { agents, auth, grants, variables, releases } = getContainer();
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

    const release =
      agent.publishedVersion != null ? await releases.get(id, agent.publishedVersion) : null;
    const allDefs = mergeVariableDefs(agent.config.variables, release?.config.variables);
    const defNames = new Set(allDefs.map((d) => d.name));

    const existing = await variables.get(id, subject.userId);
    const merged: Record<string, string> = {};

    for (const name of defNames) {
      if (existing[name] !== undefined) merged[name] = existing[name];
    }

    for (const [key, val] of Object.entries(body)) {
      if (!defNames.has(key)) continue;
      if (typeof val !== "string") {
        return Response.json({ error: `变量 ${key} 的值须为字符串` }, { status: 400 });
      }
      if (val.length > 4000) {
        return Response.json({ error: `变量 ${key} 的值不能超过 4000 字符` }, { status: 400 });
      }
      const def = allDefs.find((d) => d.name === key);
      if (def?.secret && val === "***") {
        continue;
      }
      if (val.trim()) {
        merged[key] = val;
      } else {
        delete merged[key];
      }
    }

    const totalSize = JSON.stringify(merged).length;
    if (totalSize > 500_000) {
      return Response.json({ error: "变量总数据量不能超过 500KB" }, { status: 400 });
    }

    await variables.set(id, subject.userId, merged);
    return Response.json({ ok: true });
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
}
