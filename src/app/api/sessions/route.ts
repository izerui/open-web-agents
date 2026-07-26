import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { getContainer } from "@/lib/container";
import { workspacePathFor } from "@/lib/modules/session/domain/workspace";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** 列出会话。 */
export async function GET() {
  const { sessions } = getContainer();
  return NextResponse.json({ sessions: await sessions.list() });
}

/** 新建会话:分配独立工作目录(= 项目 = 工作空间,一对一)。 */
export async function POST(req: Request) {
  const { sessions, env } = getContainer();
  const body = (await req.json().catch(() => ({}))) as { assistantId?: string; title?: string };

  const id = randomUUID().replace(/-/g, "").slice(0, 24);
  const workspaceDir = workspacePathFor(env.dataDir, id);
  await fs.mkdir(workspaceDir, { recursive: true });

  const session = await sessions.create({
    id,
    assistantId: body.assistantId ?? "default",
    workspaceDir,
    title: body.title,
  });

  return NextResponse.json({ session }, { status: 201 });
}
