// 回答智能体的提问:按题目顺序逐题校验,对到问题原文上随裁决带回;不回答走 denied;
// 普通审批不能带回答,提问不能授权同类;审计只记"答了 / 没答",不记回答内容。
import { InMemoryAuditRepo } from "@/lib/modules/audit/adapters/in-memory-audit-repo";
import { AuditLog } from "@/lib/modules/audit/application/audit-log";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolve = vi.fn(async (_id: string, _o: unknown, _r?: unknown) => true);
const auditRepo = new InMemoryAuditRepo();
const pending = [
  {
    id: "q1",
    sessionId: "s1",
    runId: "r1",
    toolName: "AskUserQuestion",
    summary: "格式? / 语言?",
    reason: "智能体在等你回答",
    toolUseId: "toolu_1",
    questions: [
      { question: "格式?", options: [{ label: "PDF" }] },
      { question: "语言?", options: [{ label: "中文" }] },
    ],
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
  },
  {
    id: "a1",
    sessionId: "s1",
    toolName: "Bash",
    summary: "ls",
    reason: "需要审批",
    createdAt: 0,
    expiresAt: Date.now() + 60_000,
  },
];
vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "u1" }),
      assertSessionAccess: async () => {},
    },
    approval: { listPending: async () => pending, resolve },
    sessions: { get: async () => ({ id: "s1", ownerId: "u1" }) },
    audit: new AuditLog({ repo: auditRepo, emailOf: async () => "u1@x.test" }),
  }),
}));

const post = async (body: unknown) => {
  const { POST } = await import("../route");
  const res = await POST(
    new Request("http://x/api/sessions/s1/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "s1" }) },
  );
  return { status: res.status, body: (await res.json()) as { error?: string } };
};

describe("回答提问", () => {
  beforeEach(() => resolve.mockClear());

  it("按题目顺序回答,对到问题原文上带回;审计不记回答内容", async () => {
    const r = await post({
      approvalId: "q1",
      decision: "approved",
      answers: [" Word、带目录 ", "中文 password=hunter2"],
    });
    expect(r.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith(
      "q1",
      {
        decision: "approved",
        by: "u1",
        answers: { "格式?": "Word、带目录", "语言?": "中文 password=hunter2" },
      },
      undefined,
    );
    const logged = JSON.stringify((await auditRepo.list({ limit: 10 })).items);
    expect(logged).toContain('"question":true');
    expect(logged).not.toContain("hunter2");
  });

  it("不回答:denied 带说明", async () => {
    expect((await post({ approvalId: "q1", decision: "denied", message: "先不答" })).status).toBe(
      200,
    );
    expect(resolve).toHaveBeenCalledWith(
      "q1",
      { decision: "denied", by: "u1", message: "先不答" },
      undefined,
    );
  });

  it("回答不全、题数不对、过长、类型不对:400,不落地", async () => {
    for (const answers of [["Word", " "], ["Word"], ["x".repeat(2001), "中文"], [1, 2], "Word"]) {
      const r = await post({ approvalId: "q1", decision: "approved", answers });
      expect(r.status, JSON.stringify(answers)).toBe(400);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("普通审批不能带回答;提问不能授权同类", async () => {
    expect((await post({ approvalId: "a1", decision: "approved", answers: ["x"] })).status).toBe(
      400,
    );
    expect(
      (
        await post({
          approvalId: "q1",
          decision: "approved",
          answers: ["a", "b"],
          remember: "session",
        })
      ).status,
    ).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });
});
