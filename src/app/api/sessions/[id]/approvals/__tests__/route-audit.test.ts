// 审批已落地后,只为审计服务的会话归属查询一直不返回:批准响应仍要在上限内返回。
//
// 真实的路由处理函数 + 真实的 AuditLog;授权、待审读取、裁决都正常完成,
// 唯独裁决之后的 sessions.get 永不兑现。

import { InMemoryAuditRepo } from "@/lib/modules/audit/adapters/in-memory-audit-repo";
import { AuditLog, AuditTimeout } from "@/lib/modules/audit/application/audit-log";
import { describe, expect, it, vi } from "vitest";

const errors: unknown[] = [];
const resolve = vi.fn(async () => true);
const sessionsGet = vi.fn(() => new Promise<never>(() => {}));

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "u1" }),
      assertSessionAccess: async () => {},
    },
    approval: {
      listPending: async () => [
        {
          id: "a1",
          sessionId: "s1",
          runId: "r1",
          toolName: "Bash",
          summary: "ls",
          reason: "需要审批",
          createdAt: 0,
          expiresAt: Date.now() + 60_000,
        },
      ],
      resolve,
    },
    sessions: { get: sessionsGet },
    audit: new AuditLog({
      repo: new InMemoryAuditRepo(),
      emailOf: async () => "u1@x.test",
      timeoutMs: 200,
      onError: (e) => errors.push(e),
    }),
  }),
}));

describe("审批:裁决后的归属查询永不兑现", () => {
  it("批准已生效,响应仍在上限内返回,超时被报告", async () => {
    const { POST } = await import("../route");
    const t0 = Date.now();
    const res = await POST(
      new Request("http://x/api/sessions/s1/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: "a1", decision: "approved" }),
      }),
      { params: Promise.resolve({ id: "s1" }) },
    );
    const ms = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1); // 裁决确实已落地
    expect(sessionsGet).toHaveBeenCalled(); // 确实卡在了归属查询上
    expect(ms).toBeLessThan(1500);
    expect(errors[0]).toBeInstanceOf(AuditTimeout);
  });
});
