// GET /api/sessions 的对话页参数:已归档视图、设计器会话、运行中标记。
import { GET as listSessions } from "@/app/api/sessions/route";
import { fixture } from "@/lib/modules/market/__tests__/fixture";
import { InMemoryRunRepo } from "@/lib/modules/run/adapters/in-memory-run-repo";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Container = Awaited<ReturnType<typeof fixture>> & { runs: InMemoryRunRepo };
let container: Container;
vi.mock("@/lib/container", () => ({ getContainer: () => container }));

function get(path: string, user = "owner") {
  return listSessions(new Request(`http://test${path}`, { headers: { "x-test-user": user } }));
}

async function ids(path: string, user = "owner"): Promise<string[]> {
  const res = await get(path, user);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sessions: { id: string }[] };
  return body.sessions.map((s) => s.id).sort();
}

beforeEach(async () => {
  container = { ...(await fixture()), runs: new InMemoryRunRepo() };
  const { sessions } = container;
  const base = { agentId: "market-agent", workspaceDir: "/ws" };
  await sessions.create({ ...base, id: "web-live", ownerId: "owner" });
  await sessions.create({ ...base, id: "web-shelved", ownerId: "owner" });
  await sessions.update("web-shelved", { status: "archived" });
  await sessions.create({ ...base, id: "web-gone", ownerId: "owner" });
  await sessions.update("web-gone", { status: "deleted" });
  await sessions.create({
    ...base,
    id: "design-live",
    agentId: "agent-architect",
    ownerId: "owner",
    source: "design",
    designTargetAgentId: "market-agent",
    designState: { draft: { name: "x" } } as never,
  });
  await sessions.create({ ...base, id: "other-user", ownerId: "someone-else" });
  await sessions.create({ ...base, id: "trial-chat", ownerId: "owner", source: "trial" });
});

describe("GET /api/sessions(对话页)", () => {
  it("默认只列自己的、未归档的网页会话,不含设计器会话", async () => {
    expect(await ids("/api/sessions")).toEqual(["web-live"]);
  });

  it("archived=1 只列归档的,已删除的不出现", async () => {
    expect(await ids("/api/sessions?archived=1")).toEqual(["web-shelved"]);
  });

  it("include=design 一并列出设计器会话,带目标智能体,不带设计状态", async () => {
    expect(await ids("/api/sessions?include=design")).toEqual(["design-live", "web-live"]);
    const body = (await (await get("/api/sessions?include=design")).json()) as {
      sessions: { id: string; source: string; designTargetAgentId?: string }[];
    };
    const design = body.sessions.find((s) => s.id === "design-live");
    expect(design?.source).toBe("design");
    expect(design?.designTargetAgentId).toBe("market-agent");
    expect(JSON.stringify(body)).not.toContain("designState");
  });

  it("构建页试聊(trial)不出现在默认、归档与 include=design 视图里", async () => {
    for (const path of [
      "/api/sessions",
      "/api/sessions?include=design",
      "/api/sessions?archived=1",
    ]) {
      expect(await ids(path)).not.toContain("trial-chat");
    }
  });

  it("别人的会话在任何视图里都看不到", async () => {
    for (const path of ["/api/sessions", "/api/sessions?archived=1&include=design"]) {
      expect(await ids(path)).not.toContain("other-user");
    }
  });

  it("activeRuns:还没结束的运行数", async () => {
    await container.runs.create({ id: "r1", sessionId: "web-live" });
    const body = (await (await get("/api/sessions")).json()) as {
      sessions: { id: string; activeRuns: number; runCount: number }[];
    };
    expect(body.sessions[0]).toMatchObject({ id: "web-live", activeRuns: 1, runCount: 1 });
  });

  it("运行中的会话带回待确认、待回答的计数;审批服务不可用时记 0,列表照常", async () => {
    await container.runs.create({ id: "r1", sessionId: "web-live" });
    const listPending = vi.fn(async (_id: string) => [
      { id: "a1", questions: undefined },
      { id: "q1", questions: [{ question: "?", options: [] }] },
      { id: "q2", questions: [{ question: "?", options: [] }] },
    ]);
    (container as unknown as { approval: unknown }).approval = { listPending };
    const body = (await (await get("/api/sessions")).json()) as {
      sessions: { id: string; pendingApprovals: number; pendingQuestions: number }[];
    };
    expect(body.sessions[0]).toMatchObject({
      id: "web-live",
      pendingApprovals: 1,
      pendingQuestions: 2,
    });
    expect(listPending).toHaveBeenCalledWith("web-live");

    listPending.mockRejectedValue(new Error("redis down"));
    const down = (await (await get("/api/sessions")).json()) as {
      sessions: { pendingApprovals: number; pendingQuestions: number }[];
    };
    expect(down.sessions[0]).toMatchObject({ pendingApprovals: 0, pendingQuestions: 0 });
  });

  it("没在运行的会话不查待审", async () => {
    const listPending = vi.fn(async () => []);
    (container as unknown as { approval: unknown }).approval = { listPending };
    await get("/api/sessions");
    expect(listPending).not.toHaveBeenCalled();
  });
});
