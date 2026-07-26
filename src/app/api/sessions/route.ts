import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { canAccessSession } from "@/lib/modules/access/domain/principal";
import { workspacePathFor } from "@/lib/modules/session/domain/workspace";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 列出调用方有权访问的会话。 */
export async function GET(req: Request) {
  const { sessions, auth } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);

    // 归属条件下推到查询,避免「先取全局最新 100 条、再过滤」导致自己的会话被别人挤掉。
    // admin 不加过滤 —— 它要能看到无归属的历史数据。
    const filter =
      principal.type === "apiKey"
        ? { callerApiKeyId: principal.keyId }
        : principal.role === "admin"
          ? undefined
          : { ownerId: principal.userId };

    // 查询已经收窄,这里的 canAccessSession 是第二道闸:授权规则只有一处权威,
    // 万一查询条件写错也由它兜住,而不是让越权数据直接流出去。
    const all = await sessions.list(filter);
    const visible = all.filter(
      (s) =>
        canAccessSession(principal, {
          id: s.id,
          assistantId: s.assistantId,
          ownerId: s.ownerId,
          callerApiKeyId: s.callerApiKeyId,
        }).allowed,
    );
    return NextResponse.json({ sessions: visible });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

/** 新建会话:分配独立工作目录(= 项目 = 工作空间,一对一),并记下归属。 */
export async function POST(req: Request) {
  const { sessions, env, auth } = getContainer();

  let principal: Awaited<ReturnType<typeof auth.resolveWeb>>;
  try {
    principal = await auth.resolveWeb(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as { assistantId?: string; title?: string };
  const assistantId = body.assistantId ?? "default";
  try {
    await auth.assertCanInvoke(principal, assistantId);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const id = randomUUID().replace(/-/g, "").slice(0, 24);
  const workspaceDir = workspacePathFor(env.dataDir, id);
  await fs.mkdir(workspaceDir, { recursive: true });

  const session = await sessions.create({
    id,
    assistantId,
    workspaceDir,
    title: body.title,
    ownerId: principal.type === "web" ? principal.userId : undefined,
    callerApiKeyId: principal.type === "apiKey" ? principal.keyId : undefined,
  });

  return NextResponse.json({ session }, { status: 201 });
}
