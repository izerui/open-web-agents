import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { apiError } from "@/lib/api-error";
import { getContainer } from "@/lib/container";
import { NothingToPublish, PublishBlocked } from "@/lib/modules/agent/application/releases";
import { contentHash, snapshotOf } from "@/lib/modules/agent/domain/release";
import type { EvalVerdict } from "@/lib/modules/eval/domain/release-gate";
import type { EvalRun } from "@/lib/modules/eval/ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 评测结论的对外形状:状态与那次评测的概要 */
function summaryOf(v: EvalVerdict | undefined) {
  if (!v) return { state: "none" as const };
  if (!("run" in v)) return { state: v.state };
  return { state: v.state, run: briefOf(v.run) };
}
const briefOf = (r: EvalRun) => ({
  id: r.id,
  passed: r.passed,
  total: r.total,
  createdAt: r.createdAt,
  finishedAt: r.finishedAt,
});

/**
 * 版本列表 + 发布状态。能看到这个智能体的人都能看(不含配置内容)。
 * 能改的人另外拿到评测结论:草稿与每个版本各自按内容摘要对上的最近一次评测(评测里有用例输入,只读者不给)
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openAgent(req, id, "read");
  if (!opened.ok) return opened.res;
  const { releases, releaseEvals, evals } = getContainer();
  const versions = await releases.list(id);
  let evalSummary: unknown;
  if (opened.canWrite) {
    const draftHash = contentHash(snapshotOf(opened.agent));
    const verdicts = await releaseEvals.verdicts(id, [
      draftHash,
      ...versions.map((v) => v.contentHash),
    ]);
    const draft = verdicts.get(draftHash);
    // 草稿这份内容没评测过:带上最近一次评测(配置已变化,不代表当前内容)
    const last = draft?.state === "none" ? (await evals.listRuns(id, 1))[0] : undefined;
    evalSummary = {
      draft: { ...summaryOf(draft), ...(last ? { previous: briefOf(last) } : {}) },
      versions: Object.fromEntries(
        versions.map((v) => [v.version, summaryOf(verdicts.get(v.contentHash))]),
      ),
    };
  }
  return Response.json({
    publishedVersion: opened.agent.publishedVersion ?? null,
    // 草稿是否改过只对能改的人有意义;只读者看到的始终是已发布版本
    hasUnpublishedChanges: opened.canWrite
      ? releases.hasUnpublishedChanges(opened.agent)
      : undefined,
    versions,
    ...(evalSummary ? { evals: evalSummary } : {}),
  });
}

/**
 * 发布:把当前草稿冻结成新版本,接口调用与 API 会话从此跑这一版。
 * 草稿与已发布完全相同时 409,避免产生内容重复的版本。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openAgent(req, id, "write");
  if (!opened.ok) return opened.res;
  const body = (await req.json().catch(() => ({}))) as { note?: unknown };
  if (body.note !== undefined && typeof body.note !== "string") {
    return apiError(400, "invalid_request", "note 必须是字符串");
  }
  try {
    const v = await getContainer().releases.publish(
      opened.agent,
      opened.subject.userId,
      body.note as string | undefined,
    );
    const { config: _config, ...meta } = v;
    await getContainer().audit.record({
      actor: opened.principal,
      action: "agent.publish",
      resource: { type: "agent", id },
      ownerId: opened.agent.ownerId,
      details: {
        version: v.version,
        previousVersion: opened.agent.publishedVersion ?? null,
        note: v.note,
      },
      req,
    });
    return Response.json({ version: meta }, { status: 201 });
  } catch (err) {
    if (err instanceof PublishBlocked) {
      return apiError(409, "eval_required", err.message);
    }
    if (err instanceof NothingToPublish) {
      return apiError(409, "nothing_to_publish", err.message, { version: err.version });
    }
    throw err;
  }
}
