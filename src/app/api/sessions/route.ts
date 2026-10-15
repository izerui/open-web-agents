import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { hasResourceAccess } from "@/lib/modules/access/domain/grants";
import { canAccessSession } from "@/lib/modules/access/domain/principal";
import { workspacePathFor } from "@/lib/modules/session/domain/workspace";
import type { SessionListFilter } from "@/lib/modules/session/ports";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 列出调用方有权访问的会话。 */
export async function GET(req: Request) {
  const { sessions, auth, runs } = getContainer();
  try {
    const principal = await auth.resolveWeb(req);

    // 归属条件下推到查询,避免「先取全局最新 100 条、再过滤」导致自己的会话被别人挤掉。
    //
    // view:
    //   (默认)        自己在工作台里的会话 —— 管理员也一样。曾经管理员默认看全部,
    //                 侧栏里混着所有人的会话和一堆标题为 invoke 的接口调用
    //   integrations  用自己的 key 发起的接口调用 / API / 嵌入会话
    //   all           全部(仅管理员,含无归属的历史数据)
    const view = new URL(req.url).searchParams.get("view");
    const filter: SessionListFilter | undefined =
      principal.type === "apiKey"
        ? { callerApiKeyId: principal.keyId }
        : view === "integrations"
          ? { billingUserId: principal.userId, sources: ["invoke", "api", "embed"] }
          : view === "all" && principal.role === "admin"
            ? undefined
            : { ownerId: principal.userId, sources: ["web"] };

    // 查询已经收窄,这里的 canAccessSession 是第二道闸:授权规则只有一处权威,
    // 万一查询条件写错也由它兜住,而不是让越权数据直接流出去。
    const all = await sessions.list(filter);
    const visible = all.filter(
      (s) =>
        canAccessSession(principal, {
          id: s.id,
          agentId: s.agentId,
          ownerId: s.ownerId,
          callerApiKeyId: s.callerApiKeyId,
          billingUserId: s.billingUserId,
        }).allowed,
    );
    /**
     * 附上运行统计。
     *
     * 【为什么在过滤之后才聚合】只对用户看得见的会话查,既少查一批,
     * 也不会因为聚合把无权访问的会话 id 带进查询条件。
     *
     * 【为什么聚合失败不整体报错】这只是列表上的两个附加数字,
     * 拿不到就不显示;让它把整个会话列表一起拖垮是不划算的。
     */
    const stats = await runs
      .statsBySessions(visible.map((s) => s.id))
      .catch(() => new Map<string, { runs: number; lastRunAt: number }>());

    return NextResponse.json({
      sessions: visible.map((s) => {
        const st = stats.get(s.id);
        return {
          ...s,
          runCount: st?.runs ?? 0,
          // 没跑过就退回创建时间 —— 列表要按"最近动过"排序,不能有空洞
          lastActiveAt: st?.lastRunAt ?? s.createdAt,
        };
      }),
    });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

/** 新建会话:分配独立工作目录(= 项目 = 工作空间,一对一),并记下归属。 */
export async function POST(req: Request) {
  const { sessions, env, auth, agents, grants, releases } = getContainer();

  let principal: Awaited<ReturnType<typeof auth.resolveWeb>>;
  try {
    principal = await auth.resolveWeb(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  // assistantId 是改名前的字段名。回退一层是因为改名不该让已接入的调用方一夜之间 400 ——
  // 新调用方用 agentId,旧的照常能跑,等确认没人再发旧字段了再摘掉。
  const body = (await req.json().catch(() => ({}))) as {
    agentId?: string;
    /* 旧字段,仅供回退 */
    assistantId?: string;
    title?: string;
    versionMode?: "published" | "draft";
  };
  if (
    body.versionMode !== undefined &&
    body.versionMode !== "published" &&
    body.versionMode !== "draft"
  ) {
    return Response.json(
      { error: "versionMode 须为 published 或 draft", code: "invalid_request" },
      { status: 400 },
    );
  }
  const agentId = body.agentId ?? body.assistantId ?? "default";
  try {
    await auth.assertCanInvoke(principal, agentId);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  /*
   * 这个会话跑哪一版:
   * - API Key 建的会话是对外调用,跑已发布版本;
   * - 市场入口显式传 published,包括作者也锁定发布版;
   * - 不传模式时,网页上能改这个智能体的人(作者)跟随草稿 —— 改完马上能试;
   *   其他人跑已发布版本,作者没发布的改动不会出现在他们的对话里。
   * 从未发布的智能体一律跑草稿。
   */
  let agentVersion: number | undefined;
  const agent = await agents.get(agentId);
  let canUseDraft = false;
  if (agent && principal.type === "web") {
    const subject = await auth.subjectOf(principal);
    const list = await grants.listForResource("agent", agentId);
    canUseDraft = hasResourceAccess(subject, agent, "write", list);
  }
  if (body.versionMode === "draft" && !canUseDraft) {
    return Response.json(
      { error: "仅有编辑权限的登录用户可试运行草稿", code: "forbidden" },
      { status: 403 },
    );
  }
  if (body.versionMode === "published" && agent?.publishedVersion === undefined) {
    return Response.json({ error: "智能体尚未发布", code: "not_published" }, { status: 409 });
  }
  if (agent?.publishedVersion !== undefined && (body.versionMode === "published" || !canUseDraft)) {
    agentVersion = (await releases.resolve(agent)).version ?? undefined;
  }

  const id = randomUUID().replace(/-/g, "").slice(0, 24);
  const workspaceDir = workspacePathFor(env.dataDir, id);
  await fs.mkdir(workspaceDir, { recursive: true });

  const session = await sessions.create({
    id,
    agentId,
    workspaceDir,
    title: body.title,
    ownerId: principal.type === "web" ? principal.userId : undefined,
    callerApiKeyId: principal.type === "apiKey" ? principal.keyId : undefined,
    // API Key 建的会话没有人用归属,但花费要记在签发人头上
    billingUserId: principal.type === "web" ? principal.userId : principal.ownerId,
    source: principal.type === "web" ? "web" : "api",
    agentVersion,
  });

  return NextResponse.json({ session }, { status: 201 });
}
