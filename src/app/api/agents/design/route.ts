import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { getContainer } from "@/lib/container";
import { agentAccessLevel } from "@/lib/modules/access/domain/principal";
import { draftOf } from "@/lib/modules/agent/domain/design";
import { contentHash, snapshotOf } from "@/lib/modules/agent/domain/release";
import { DESIGN_EXECUTOR_ID } from "@/lib/modules/agent/domain/system-agent";
import { workspacePathFor } from "@/lib/modules/session/domain/workspace";
import { designCaller, designError } from "./_lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { subject } = await designCaller(req);
    const { sessions } = getContainer();
    const list = await sessions.list({ ownerId: subject.userId, sources: ["design"] });
    return Response.json({
      sessions: list.map(({ id, title, createdAt, designTargetAgentId }) => ({
        id,
        title,
        createdAt,
        designTargetAgentId,
      })),
    });
  } catch (err) {
    return designError(err);
  }
}

export async function POST(req: Request) {
  try {
    const { principal, subject } = await designCaller(req);
    const { agents, grants, sessions, env } = getContainer();
    const body = (await req.json().catch(() => ({}))) as { agentId?: unknown };
    if (body.agentId !== undefined && typeof body.agentId !== "string") {
      return Response.json({ error: "agentId 必须是文本" }, { status: 400 });
    }
    const target = body.agentId ? await agents.get(body.agentId) : null;
    if (
      body.agentId &&
      (!target ||
        agentAccessLevel(
          principal,
          target,
          subject,
          await grants.listForResource("agent", target.id),
        ) !== "write")
    ) {
      return Response.json({ error: "没有编辑权限或智能体不存在" }, { status: 403 });
    }
    const id = randomUUID().replace(/-/g, "").slice(0, 24);
    const workspaceDir = workspacePathFor(env.dataDir, id);
    await fs.mkdir(workspaceDir, { recursive: true });
    await sessions.create({
      id,
      workspaceDir,
      agentId: DESIGN_EXECUTOR_ID,
      title: target ? `设计:${target.name}` : "设计:新智能体",
      ownerId: subject.userId,
      billingUserId: subject.userId,
      source: "design",
      designTargetAgentId: target?.id,
      designState: {
        baseHash: target ? contentHash(snapshotOf(target)) : null,
        resourceAgentIds: target ? [target.id] : [],
        draft: draftOf(target ?? undefined),
      },
    });
    return Response.json({ sessionId: id }, { status: 201 });
  } catch (err) {
    return designError(err);
  }
}
