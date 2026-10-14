import { InMemoryAuditRepo } from "@/lib/modules/audit/adapters/in-memory-audit-repo";
import { AuditLog, AuditTimeout } from "@/lib/modules/audit/application/audit-log";
import { describe, expect, it } from "vitest";

describe("AuditLog.record", () => {
  it("记下操作者快照、来源地址与脱敏后的细节", async () => {
    const repo = new InMemoryAuditRepo();
    const log = new AuditLog({ repo, emailOf: async () => "a@x.test", now: () => 1000 });
    await log.record({
      actor: { type: "web", userId: "u1" },
      action: "api_key.issue",
      resource: { type: "api_key", id: "k1" },
      ownerId: "u1",
      details: { name: "订单", plaintext: "owa_xxx", secret: "s" },
      req: new Request("http://x", {
        headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1", "user-agent": "curl/8" },
      }),
    });
    const [e] = repo.events;
    expect(e?.actor).toEqual({ type: "user", id: "u1", label: "a@x.test" });
    expect(e?.at).toBe(1000);
    expect(e?.ip).toBe("1.2.3.4");
    expect(e?.userAgent).toBe("curl/8");
    expect(e?.details).toEqual({ name: "订单", plaintext: "***", secret: "***" });
  });

  it("API Key 操作者:记 Key id,标签写签发人", async () => {
    const repo = new InMemoryAuditRepo();
    const log = new AuditLog({ repo, emailOf: async () => "owner@x.test" });
    await log.record({
      actor: { type: "apiKey", keyId: "k9", ownerId: "u1" },
      action: "agent.update",
      resource: { type: "agent", id: "a1" },
    });
    expect(repo.events[0]?.actor).toEqual({ type: "apiKey", id: "k9", label: "Key(owner@x.test)" });
  });

  it("写入失败不抛错(业务已生效),只报告", async () => {
    const errors: unknown[] = [];
    const log = new AuditLog({
      repo: {
        append: async () => {
          throw new Error("db down");
        },
        list: async () => ({ items: [] }),
      },
      onError: (e) => errors.push(e),
    });
    await expect(
      log.record({
        actor: { type: "anonymous" },
        action: "auth.login_failed",
        resource: { type: "account" },
      }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe("AuditLog.record:有界返回", () => {
  const never = <T>() => new Promise<T>(() => {});

  it("查邮箱永不返回:在总上限内返回,并报告超时", async () => {
    const errors: unknown[] = [];
    const repo = new InMemoryAuditRepo();
    const log = new AuditLog({
      repo,
      emailOf: never,
      timeoutMs: 100,
      onError: (e) => errors.push(e),
    });
    const t0 = Date.now();
    await log.record({
      actor: { type: "web", userId: "u1" },
      action: "auth.login",
      resource: { type: "account" },
    });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(errors[0]).toBeInstanceOf(AuditTimeout);
    expect(repo.events).toHaveLength(0);
  });

  it("写入永不返回:同样有界返回", async () => {
    const errors: unknown[] = [];
    const log = new AuditLog({
      repo: { append: never, list: async () => ({ items: [] }) },
      timeoutMs: 100,
      onError: (e) => errors.push(e),
    });
    const t0 = Date.now();
    await log.record({
      actor: { type: "anonymous" },
      action: "auth.login_failed",
      resource: { type: "account" },
    });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(errors[0]).toBeInstanceOf(AuditTimeout);
  });
});
