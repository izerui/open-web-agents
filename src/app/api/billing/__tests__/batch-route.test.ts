import { Forbidden } from "@/lib/modules/access/application/authorize";
import { InMemoryAuditRepo } from "@/lib/modules/audit/adapters/in-memory-audit-repo";
import { AuditLog } from "@/lib/modules/audit/application/audit-log";
import { InMemoryBillingRepo } from "@/lib/modules/billing/adapters/in-memory-billing-repo";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  admin: true,
  /** 这些账号下一次入账时抛普通错误(模拟连接断开),各一次 */
  failCredit: new Set<string>(),
  /** 这些账号下一次写审计时失败,各一次 */
  failAudit: new Set<string>(),
}));
let billing = new InMemoryBillingRepo();
class FlakyAuditRepo extends InMemoryAuditRepo {
  override async append(e: Parameters<InMemoryAuditRepo["append"]>[0]) {
    if (e.ownerId && state.failAudit.delete(e.ownerId)) throw new Error("audit db down");
    return super.append(e);
  }
}
let auditRepo = new FlakyAuditRepo();
const audit = () => new AuditLog({ repo: auditRepo });
/** 实际落库的审计(按去重键只记一条) */
const audited = async () => (await auditRepo.list({ limit: 200 })).items;
const USERS = [
  { id: "u1", email: "a@x.com", disabled: false },
  { id: "u2", email: "off@x.com", disabled: true },
  { id: "u3", email: "b@x.com", disabled: false },
  { id: "u4", email: "c@x.com", disabled: false },
];
vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    billing: {
      credit: async (input: Parameters<InMemoryBillingRepo["credit"]>[0]) => {
        if (state.failCredit.delete(input.accountId)) throw new Error("connection lost");
        return billing.credit(input);
      },
      findCredit: (accountId: string, key: string) => billing.findCredit(accountId, key),
    },
    audit: { record: (e: Parameters<AuditLog["record"]>[0]) => audit().record(e) },
    users: { findByEmail: async (e: string) => USERS.find((u) => u.email === e) ?? null },
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "admin" }),
      subjectOf: async () => ({ userId: "admin" }),
      assertCanAdministerPlatform: () => {
        if (!state.admin) throw new Forbidden("admin only");
      },
    },
  }),
}));
import { POST } from "../credits/batch/route";

const call = (body: unknown, key?: string) =>
  POST(
    new Request("http://test/api/billing/credits/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      body: JSON.stringify(body),
    }),
  );

describe("POST /api/billing/credits/batch", () => {
  beforeEach(() => {
    for (const u of USERS) u.disabled = u.id === "u2";
    billing = new InMemoryBillingRepo();
    state.admin = true;
    auditRepo = new FlakyAuditRepo();
    state.failCredit.clear();
    state.failAudit.clear();
  });

  it("只有管理员能用", async () => {
    state.admin = false;
    expect((await call({ emails: "a@x.com", preview: true })).status).toBe(403);
  });

  it("预览不入账、不写审计", async () => {
    const r = await call({ emails: "a@x.com\noff@x.com\nnone@x.com", preview: true });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { lines: { status: string }[] };
    expect(body.lines.map((l) => l.status)).toEqual(["ready", "disabled", "not_found"]);
    expect((await billing.balance("u1")).availableMicroCredits).toBe("0");
    expect(await audited()).toHaveLength(0);
  });

  it("发放须带批次编号、积分与说明", async () => {
    const ok = { emails: "a@x.com", credits: "10", reason: "活动" };
    expect((await call(ok)).status).toBe(400);
    expect((await call({ ...ok, credits: "0" }, "b1")).status).toBe(400);
    expect((await call({ ...ok, reason: " " }, "b1")).status).toBe(400);
    expect((await call(ok, "x".repeat(101))).status).toBe(400);
  });

  it("发放:只给可发放的入账,每个入账账号记一条审计;重试不重复入账、不重复审计", async () => {
    const body = { emails: "a@x.com\noff@x.com", credits: "10", reason: "活动" };
    const r = await call(body, "batch-1");
    expect(await r.json()).toMatchObject({ credited: 1, replayed: 0, skipped: 1, failed: 0 });
    expect((await billing.balance("u1")).availableMicroCredits).toBe("10000000");
    expect(await audited()).toHaveLength(1);
    expect((await audited())[0]).toMatchObject({
      action: "billing.credit",
      ownerId: "u1",
      details: { via: "batch", amountMicroCredits: "10000000" },
    });

    const again = await call(body, "batch-1");
    expect(await again.json()).toMatchObject({ credited: 0, replayed: 1 });
    expect((await billing.balance("u1")).availableMicroCredits).toBe("10000000");
    expect(await audited()).toHaveLength(1);
  });

  it("故障注入:A 成功、B 首次写库抛错、C 成功 → 原批次重试 → 三个余额各只增加一次,审计各恰好一条", async () => {
    const body = { emails: "a@x.com\nb@x.com\nc@x.com", credits: "10", reason: "活动" };
    state.failCredit.add("u3");
    const first = await call(body, "batch-x");
    expect(first.status).toBe(200);
    const r1 = (await first.json()) as {
      lines: { email: string; status: string; error?: string }[];
    };
    expect(r1.lines.map((l) => l.status)).toEqual(["credited", "failed", "credited"]);
    // 内部错误不原样透出
    expect(r1.lines[1]?.error).not.toContain("connection lost");
    expect((await billing.balance("u4")).availableMicroCredits).toBe("10000000");

    const second = await call(body, "batch-x");
    const r2 = (await second.json()) as { lines: { status: string }[] };
    expect(r2.lines.map((l) => l.status)).toEqual(["replayed", "credited", "replayed"]);

    for (const id of ["u1", "u3", "u4"]) {
      expect((await billing.balance(id)).availableMicroCredits).toBe("10000000");
      expect((await audited()).filter((e) => e.ownerId === id)).toHaveLength(1);
    }
    expect(await audited()).toHaveLength(3);
  });

  it("第一次已到账但审计没写成:原批次重试补上审计,不重复入账、不重复审计", async () => {
    const body = { emails: "a@x.com", credits: "10", reason: "活动" };
    state.failAudit.add("u1");
    const first = (await (await call(body, "batch-y")).json()) as {
      lines: { status: string; auditPending?: boolean }[];
      credited: number;
      failed: number;
      auditPending: number;
    };
    // 已到账但审计没写成:单独标出来,不能看起来像全部成功
    expect(first).toMatchObject({ credited: 1, failed: 0, auditPending: 1 });
    expect(first.lines[0]).toMatchObject({ status: "credited", auditPending: true });
    expect((await billing.balance("u1")).availableMicroCredits).toBe("10000000");
    expect(await audited()).toHaveLength(0);
    const retry = (await (await call(body, "batch-y")).json()) as {
      lines: { auditPending?: boolean }[];
      auditPending: number;
    };
    expect(retry.auditPending).toBe(0);
    expect(retry.lines[0]?.auditPending).toBeUndefined();
    await call(body, "batch-y");
    expect((await billing.balance("u1")).availableMicroCredits).toBe("10000000");
    expect(await audited()).toHaveLength(1);
  });

  it("到账 → 审计失败 → 账号被停用 → 原批次重试:按原流水重放并补齐审计,余额不变;没到过账的停用账号仍拿不到", async () => {
    const body = { emails: "a@x.com\noff@x.com", credits: "10", reason: "活动" };
    state.failAudit.add("u1");
    const first = (await (await call(body, "batch-z")).json()) as { lines: { status: string }[] };
    expect(first.lines.map((l) => l.status)).toEqual(["credited", "disabled"]);
    expect(await audited()).toHaveLength(0);

    const a = USERS.find((u) => u.id === "u1");
    if (a) a.disabled = true; // 管理员随后停用了 A

    const again = (await (await call(body, "batch-z")).json()) as { lines: { status: string }[] };
    expect(again.lines.map((l) => l.status)).toEqual(["replayed", "disabled"]);
    expect((await billing.balance("u1")).availableMicroCredits).toBe("10000000");
    expect((await billing.balance("u2")).availableMicroCredits).toBe("0");
    const rows = await audited();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: "u1", details: { via: "batch" } });

    // 停用账号用一个新批次:不会获得积分
    const fresh = (await (await call(body, "batch-new")).json()) as { lines: { status: string }[] };
    expect(fresh.lines.map((l) => l.status)).toEqual(["disabled", "disabled"]);
    expect((await billing.balance("u1")).availableMicroCredits).toBe("10000000");
  });

  it("停用账号的原批次重试换了金额:报冲突失败,不按停用跳过,也不改动余额", async () => {
    await call({ emails: "a@x.com", credits: "10", reason: "活动" }, "batch-c");
    const a = USERS.find((u) => u.id === "u1");
    if (a) a.disabled = true;
    const r = (await (
      await call({ emails: "a@x.com", credits: "20", reason: "活动" }, "batch-c")
    ).json()) as { lines: { status: string }[] };
    expect(r.lines.map((l) => l.status)).toEqual(["failed"]);
    expect((await billing.balance("u1")).availableMicroCredits).toBe("10000000");
  });
});
