// 业务已完成、审计依赖却一直不返回时,HTTP 响应仍要有界结束。
//
// 用真实的路由处理函数 + 真实的 AuditLog,只把审计的两个依赖换成"永不兑现":
// 一次是查邮箱快照,一次是写入。断言:业务写入已发生、响应在上限内返回、超时被报告。

import { AuditLog, AuditTimeout } from "@/lib/modules/audit/application/audit-log";
import { afterEach, describe, expect, it, vi } from "vitest";

const never = <T>() => new Promise<T>(() => {});
const state: { audit?: AuditLog; setCredentials: ReturnType<typeof vi.fn> } = {
  setCredentials: vi.fn(async () => {}),
};

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    authService: { currentUser: async () => ({ id: "u1", email: "u1@x.test" }) },
    users: { setCredentials: state.setCredentials, get: async () => ({ id: "u1" }) },
    secrets: { encrypt: (v: string) => `enc:${v}` },
    audit: state.audit,
  }),
}));

async function post(): Promise<{ res: Response; ms: number }> {
  const { POST } = await import("../route");
  const t0 = Date.now();
  const res = await POST(
    new Request("http://x/api/me/webhook-secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  return { res, ms: Date.now() - t0 };
}

describe("审计依赖不返回时,已完成的业务仍有界响应", () => {
  afterEach(() => {
    state.setCredentials.mockClear();
  });

  it("查邮箱永不兑现", async () => {
    const errors: unknown[] = [];
    state.audit = new AuditLog({
      repo: { append: async () => {}, list: async () => ({ items: [] }) },
      emailOf: never,
      timeoutMs: 200,
      onError: (e) => errors.push(e),
    });
    const { res, ms } = await post();
    expect(res.status).toBe(201);
    expect(state.setCredentials).toHaveBeenCalledTimes(1); // 业务确实已生效
    expect(ms).toBeLessThan(1500);
    expect(errors[0]).toBeInstanceOf(AuditTimeout);
  });

  it("写入审计永不兑现", async () => {
    const errors: unknown[] = [];
    state.audit = new AuditLog({
      repo: { append: never, list: async () => ({ items: [] }) },
      emailOf: async () => "u1@x.test",
      timeoutMs: 200,
      onError: (e) => errors.push(e),
    });
    const { res, ms } = await post();
    expect(res.status).toBe(201);
    expect(state.setCredentials).toHaveBeenCalledTimes(1);
    expect(ms).toBeLessThan(1500);
    expect(errors[0]).toBeInstanceOf(AuditTimeout);
  });
});
