import { Unauthorized } from "@/lib/modules/access/application/authorize";
import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import type { FileNode } from "@/lib/modules/artifacts/ports";
import type { LatestRun } from "@/lib/modules/run/adapters/mysql-run-query";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import type { SessionListFilter } from "@/lib/modules/session/ports";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

type Ctx = ReturnType<typeof build>;
let ctx: Ctx;
vi.mock("@/lib/container", () => ({ getContainer: () => ctx }));

function build() {
  const sessions = new InMemorySessionRepo();
  const agents = new InMemoryAgentRepo([
    {
      id: "a1",
      ownerId: "u1",
      name: "会议纪要整理",
      config: { model: "sonnet", systemPrompt: "x" },
    },
    {
      id: "a2",
      ownerId: "other",
      name: "Draft secret",
      config: { model: "sonnet", systemPrompt: "x" },
    },
  ]);
  const listSpy = vi.spyOn(sessions, "list");
  const latest = new Map<string, LatestRun>();
  const lastRunAt = new Map<string, number>();
  const trees = new Map<string, FileNode[] | Error>();
  return {
    sessions,
    agents,
    listSpy,
    latest,
    lastRunAt,
    trees,
    user: "u1" as string | null,
    auth: {
      resolveWeb: async () => {
        if (!ctx.user) throw new Unauthorized("login required");
        return { type: "web", userId: ctx.user, role: "user" } as const;
      },
    },
    runs: {
      statsBySessions: async (ids: string[]) =>
        new Map(
          ids.flatMap((id) => {
            const at = ctx.lastRunAt.get(id);
            return at === undefined ? [] : [[id, { runs: 1, lastRunAt: at }] as const];
          }),
        ),
    },
    runQuery: {
      latestBySessions: async (ids: string[]) =>
        new Map(
          ids.flatMap((id) =>
            ctx.latest.has(id) ? [[id, ctx.latest.get(id) as LatestRun] as const] : [],
          ),
        ),
    },
    releases: {
      publishedOf: async () =>
        new Map([["a2", { agentId: "a2", version: 1, name: "公开名称", icon: undefined }]]),
    },
    storage: {
      tree: async (dir: string) => {
        const t = ctx.trees.get(dir);
        if (t instanceof Error) throw t;
        return t ?? [];
      },
    },
  };
}

async function body() {
  const res = await GET(new Request("http://test/api/sessions/recent"));
  return {
    status: res.status,
    json: (await res.json()) as { sessions: Record<string, unknown>[] },
  };
}

beforeEach(() => {
  ctx = build();
});

describe("GET /api/sessions/recent", () => {
  it("未登录 401", async () => {
    ctx.user = null;
    expect((await body()).status).toBe(401);
  });

  it("只查本人的工作台会话", async () => {
    await body();
    expect(ctx.listSpy).toHaveBeenCalledWith({
      ownerId: "u1",
      sources: ["web"],
    } satisfies SessionListFilter);
  });

  it("按最近活动倒序取 5 个,带状态、摘要、智能体名称与交付文件", async () => {
    for (let i = 0; i < 7; i++) {
      await ctx.sessions.create({
        id: `s${i}`,
        agentId: "a1",
        workspaceDir: `/w/s${i}`,
        ownerId: "u1",
        title: `会话 ${i}`,
      });
      ctx.lastRunAt.set(`s${i}`, 1000 + i);
    }
    // 别人的会话不出现
    await ctx.sessions.create({ id: "x", agentId: "a1", workspaceDir: "/w/x", ownerId: "u2" });
    ctx.latest.set("s6", {
      sessionId: "s6",
      status: "success",
      promptPreview: "整理例会录音",
      replyPreview: "共 4 项决议",
      createdAt: 1006,
      startedAt: 1006,
    });
    ctx.trees.set("/w/s6", [
      { path: "纪要.md", name: "纪要.md", type: "file", size: 12, mtime: 2000 },
    ]);
    ctx.latest.set("s5", {
      sessionId: "s5",
      status: "running",
      promptPreview: "初审发票",
      createdAt: 1005,
    });
    ctx.latest.set("s4", {
      sessionId: "s4",
      status: "success",
      promptPreview: "问汇率",
      replyPreview: "按 7.12 换算",
      createdAt: 1004,
      startedAt: 1004,
    });
    ctx.trees.set("/w/s4", new Error("EACCES"));

    const { status, json } = await body();
    expect(status).toBe(200);
    expect(json.sessions.map((s) => s.id)).toEqual(["s6", "s5", "s4", "s3", "s2"]);
    expect(json.sessions[0]).toMatchObject({
      title: "会话 6",
      agent: { id: "a1", name: "会议纪要整理" },
      status: "delivered",
      lastRun: { status: "success", prompt: "整理例会录音", reply: "共 4 项决议" },
      file: { name: "纪要.md", path: "纪要.md" },
    });
    expect(json.sessions[1]).toMatchObject({ status: "running", file: null });
    // 读文件失败:不带文件卡,也不报错
    expect(json.sessions[2]).toMatchObject({ status: "replied", file: null });
    expect(json.sessions[3]).toMatchObject({ status: "idle", lastRun: null });
    expect(JSON.stringify(json)).not.toContain("workspaceDir");
  });

  it("锁定发布版的会话显示发布版名称,不泄露草稿", async () => {
    await ctx.sessions.create({
      id: "m1",
      agentId: "a2",
      workspaceDir: "/w/m1",
      ownerId: "u1",
      agentVersion: 1,
    });
    const { json } = await body();
    expect(json.sessions[0]).toMatchObject({ agent: { id: "a2", name: "公开名称" } });
    expect(JSON.stringify(json)).not.toContain("Draft secret");
  });
});
