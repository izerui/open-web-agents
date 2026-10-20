import { Forbidden, Unauthorized } from "@/lib/modules/access/application/authorize";
import { InMemoryAuditRepo } from "@/lib/modules/audit/adapters/in-memory-audit-repo";
import { AuditLog } from "@/lib/modules/audit/application/audit-log";
import { InMemoryBillingRepo } from "@/lib/modules/billing/adapters/in-memory-billing-repo";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ admin: false, apiKey: false, authenticated: true }));
let billing = new InMemoryBillingRepo();
const auditFault = { failNext: false };
class FlakyAuditRepo extends InMemoryAuditRepo {
  override async append(e: Parameters<InMemoryAuditRepo["append"]>[0]) {
    if (auditFault.failNext) {
      auditFault.failNext = false;
      throw new Error("audit db down");
    }
    return super.append(e);
  }
}
let auditRepo = new FlakyAuditRepo();
const audit = () => new AuditLog({ repo: auditRepo });
/** 实际落库的审计(按去重键只记一条) */
const audited = async () => (await auditRepo.list({ limit: 200 })).items;
vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    billing,
    runCharges: { monthUsageByAccount: async () => new Map() },
    audit: { record: (e: Parameters<AuditLog["record"]>[0]) => audit().record(e) },
    users: {
      get: async (id: string) =>
        ["alice", "bob"].includes(id.toLowerCase()) ? { id: id.toLowerCase() } : null,
    },
    auth: {
      resolveWeb: async () => {
        if (!state.authenticated) throw new Unauthorized("login required");
        return state.apiKey
          ? { type: "apiKey", ownerId: "alice" }
          : { type: "web", userId: "alice" };
      },
      subjectOf: async () => ({ userId: "alice" }),
      assertCanAdministerPlatform: () => {
        if (!state.admin || state.apiKey) throw new Forbidden("admin only");
      },
    },
  }),
}));
import { POST } from "../credits/route";
import { GET } from "../route";

const credit = (credits = "12.000001", key: string | null = "credit-1", accountId = "bob") =>
  POST(
    new Request("http://test/api/billing/credits", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      body: JSON.stringify({ accountId, credits, reason: "试用发放" }),
    }),
  );

describe("billing HTTP permissions and idempotency", () => {
  beforeEach(() => {
    billing = new InMemoryBillingRepo();
    state.admin = false;
    state.apiKey = false;
    state.authenticated = true;
    auditRepo = new FlakyAuditRepo();
    auditFault.failNext = false;
  });
  it("requires login, isolates account statements and rejects integration keys", async () => {
    state.authenticated = false;
    expect((await GET(new Request("http://test/api/billing"))).status).toBe(401);
    state.authenticated = true;
    expect((await GET(new Request("http://test/api/billing?accountId=bob"))).status).toBe(403);
    state.apiKey = true;
    expect((await GET(new Request("http://test/api/billing"))).status).toBe(403);
    expect((await credit()).status).toBe(403);
  });
  it("users can read only their own balance and cannot issue credits", async () => {
    const response = await GET(new Request("http://test/api/billing"));
    expect(await response.json()).toMatchObject({
      balance: { accountId: "alice", availableMicroCredits: "0", reservedMicroCredits: "0" },
      items: [],
      paymentsConnected: false,
    });
    expect((await credit()).status).toBe(403);
  });
  it("admin credits are exact, replay-safe and audited once", async () => {
    state.admin = true;
    const first = await credit();
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      balance: { availableMicroCredits: "12000001" },
      replayed: false,
    });
    const again = await credit();
    expect(again.status).toBe(200);
    expect((await again.json()).replayed).toBe(true);
    expect((await credit("13")).status).toBe(409);
    expect((await billing.balance("bob")).availableMicroCredits).toBe("12000001");
    expect(await audited()).toHaveLength(1);
    expect((await GET(new Request("http://test/api/billing?accountId=bob"))).status).toBe(200);
  });
  it("first credit lands but its audit fails: replaying the same request fills the audit once", async () => {
    state.admin = true;
    auditFault.failNext = true;
    expect((await credit()).status).toBe(201);
    expect(await audited()).toHaveLength(0);
    expect((await credit()).status).toBe(200);
    expect((await credit()).status).toBe(200);
    expect((await billing.balance("bob")).availableMicroCredits).toBe("12000001");
    expect(await audited()).toHaveLength(1);
  });
  it("uses the canonical identity ID, not a second wallet for a differently cased lookup", async () => {
    state.admin = true;
    expect((await credit("1", "canonical", "BOB")).status).toBe(201);
    expect((await billing.balance("bob")).availableMicroCredits).toBe("1000000");
    expect((await billing.balance("BOB")).availableMicroCredits).toBe("0");
  });
  it("rejects missing idempotency, invalid precision, zero and unknown accounts", async () => {
    state.admin = true;
    expect((await credit("1", null)).status).toBe(400);
    for (const value of ["-1", "0", "1e3", "0.0000001"])
      expect((await credit(value)).status).toBe(400);
    expect((await credit("1", "unknown", "nobody")).status).toBe(404);
    expect(await audited()).toHaveLength(0);
    expect((await billing.balance("bob")).availableMicroCredits).toBe("0");
  });
});
