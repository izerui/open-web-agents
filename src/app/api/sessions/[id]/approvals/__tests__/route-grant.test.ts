// 审批分级:批准一次 / 批准并授权本会话内同类 / 拒绝(可附说明)/ 撤销同类授权。
// 真实路由处理函数 + 真实 AuditLog;审批端口用可观察的假实现。

import type { ApprovalOutcome, ApprovalRequest, SessionGrant } from "@/lib/modules/approval/ports";
import { InMemoryAuditRepo } from "@/lib/modules/audit/adapters/in-memory-audit-repo";
import { AuditLog } from "@/lib/modules/audit/application/audit-log";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auditRepo = new InMemoryAuditRepo();
const state = {
  pending: [] as ApprovalRequest[],
  grants: [] as SessionGrant[],
  resolved: [] as { id: string; outcome: ApprovalOutcome; remember?: unknown }[],
};

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "u1" }),
      assertSessionAccess: async () => {},
    },
    approval: {
      listPending: async () => state.pending,
      grants: async () => state.grants,
      resolve: async (id: string, outcome: ApprovalOutcome, remember?: unknown) => {
        state.resolved.push({ id, outcome, remember });
        return true;
      },
      revokeGrant: async (_s: string, key: string) => {
        const before = state.grants.length;
        state.grants = state.grants.filter((g) => g.key !== key);
        return state.grants.length < before;
      },
    },
    sessions: { get: async () => ({ id: "s1", ownerId: "u1" }) },
    audit: new AuditLog({ repo: auditRepo, emailOf: async () => "u1@x.test" }),
  }),
}));

const pendingOf = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: "a1",
  sessionId: "s1",
  runId: "r1",
  toolName: "Bash",
  summary: "curl https://x",
  reason: "命令包含高风险模式:curl",
  grant: { key: "bash:curl", label: "含「curl」的命令" },
  createdAt: 0,
  expiresAt: Date.now() + 60_000,
  ...over,
});

async function call(method: "POST" | "GET" | "DELETE", body?: unknown, query = "") {
  const mod = await import("../route");
  const req = new Request(`http://x/api/sessions/s1/approvals${query}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const res = await mod[method](req, { params: Promise.resolve({ id: "s1" }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("审批分级", () => {
  beforeEach(() => {
    state.pending = [pendingOf()];
    state.grants = [];
    state.resolved = [];
    auditRepo.events.length = 0;
  });

  it("批准一次:不带授权", async () => {
    expect((await call("POST", { approvalId: "a1", decision: "approved" })).status).toBe(200);
    expect(state.resolved).toEqual([
      { id: "a1", outcome: { decision: "approved", by: "u1" }, remember: undefined },
    ]);
  });

  it("批准并授权本会话内同类:授权随裁决一起提交,类别取自待审请求(不信任请求体),并进审计", async () => {
    const r = await call("POST", { approvalId: "a1", decision: "approved", remember: "session" });
    expect(r).toMatchObject({ status: 200, body: { remembered: true } });
    expect(state.resolved[0]?.remember).toEqual({
      sessionId: "s1",
      grant: { key: "bash:curl", label: "含「curl」的命令", by: "u1", at: expect.any(Number) },
    });
    const ev = auditRepo.events.find((e) => e.action === "approval.decide");
    expect(ev?.details).toMatchObject({
      decision: "approved",
      remember: true,
      grantCategory: "bash:curl",
    });
  });

  it("拒绝时不能授权同类;没有类别的调用不能授权同类;remember 取值非法 —— 都是 400 且不裁决", async () => {
    expect(
      (await call("POST", { approvalId: "a1", decision: "denied", remember: "session" })).status,
    ).toBe(400);
    state.pending = [pendingOf({ grant: undefined })];
    expect(
      (await call("POST", { approvalId: "a1", decision: "approved", remember: "session" })).status,
    ).toBe(400);
    expect(
      (await call("POST", { approvalId: "a1", decision: "approved", remember: "forever" })).status,
    ).toBe(400);
    expect(state.resolved).toEqual([]);
  });

  it("拒绝并说明:说明去掉首尾空白后作为拒绝原因提交;过长 400", async () => {
    await call("POST", { approvalId: "a1", decision: "denied", message: "  改用 wget  " });
    expect(state.resolved[0]?.outcome).toEqual({
      decision: "denied",
      by: "u1",
      message: "改用 wget",
    });
    expect(
      (await call("POST", { approvalId: "a1", decision: "denied", message: "x".repeat(2001) }))
        .status,
    ).toBe(400);
  });

  it("列表带出本会话的同类授权;撤销:存在 200 并进审计,不存在 404,缺参数 400", async () => {
    state.grants = [{ key: "bash:curl", label: "含「curl」的命令", at: 1 }];
    expect((await call("GET")).body.grants).toEqual(state.grants);
    expect((await call("DELETE", undefined, "?grant=bash%3Acurl")).status).toBe(200);
    expect(state.grants).toEqual([]);
    const ev = auditRepo.events.find((e) => e.action === "approval.revoke_grant");
    expect(ev?.details).toEqual({ grantCategory: "bash:curl", grantLabel: "含「curl」的命令" });
    expect((await call("DELETE", undefined, "?grant=bash%3Acurl")).status).toBe(404);
    expect((await call("DELETE")).status).toBe(400);
  });
});
