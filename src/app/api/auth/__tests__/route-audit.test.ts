// 登录失败已确定后,只为审计服务的账号查询一直不返回:401 仍要在上限内返回。

import { InMemoryAuditRepo } from "@/lib/modules/audit/adapters/in-memory-audit-repo";
import { AuditLog, AuditTimeout } from "@/lib/modules/audit/application/audit-log";
import { AuthError } from "@/lib/modules/identity/application/auth-service";
import { describe, expect, it, vi } from "vitest";

const errors: unknown[] = [];
const findByEmail = vi.fn(() => new Promise<never>(() => {}));

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    authService: {
      login: async () => {
        throw new AuthError("邮箱或密码不正确", 401);
      },
    },
    rateLimiter: {
      hit: async () => ({ allowed: true, retryAfterMs: 0, remaining: 9, resetMs: 0 }),
    },
    env: { authIpRateLimit: 0 },
    users: { findByEmail },
    audit: new AuditLog({
      repo: new InMemoryAuditRepo(),
      timeoutMs: 200,
      onError: (e) => errors.push(e),
    }),
  }),
}));

describe("登录失败:审计用的账号查询永不兑现", () => {
  it("仍在上限内返回 401,超时被报告", async () => {
    const { POST } = await import("../route");
    const t0 = Date.now();
    const res = await POST(
      new Request("http://x/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", email: "a@x.test", password: "wrong-pass" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(findByEmail).toHaveBeenCalled();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(errors[0]).toBeInstanceOf(AuditTimeout);
  });
});
