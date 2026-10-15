import { Forbidden, Unauthorized } from "@/lib/modules/access/application/authorize";
import { InMemoryBillingRepo } from "@/lib/modules/billing/adapters/in-memory-billing-repo";
import { InMemoryPackageRepo } from "@/lib/modules/billing/adapters/in-memory-package-repo";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  userId: "alice",
  admin: false,
  apiKey: false,
  authenticated: true,
}));
let billing = new InMemoryBillingRepo();
let packages = new InMemoryPackageRepo(billing);
vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    billing,
    packages,
    audit: {
      record: vi.fn(async () => {}),
    },
    users: {
      get: async (id: string) =>
        ["alice", "bob"].includes(id) ? { id, email: `${id}@example.test` } : null,
    },
    auth: {
      resolveWeb: async () => {
        if (!state.authenticated) throw new Unauthorized("login required");
        return state.apiKey
          ? { type: "apiKey", ownerId: state.userId }
          : { type: "web", userId: state.userId };
      },
      subjectOf: async () => ({ userId: state.userId }),
      assertCanAdministerPlatform: () => {
        if (!state.admin || state.apiKey) throw new Forbidden("admin only");
      },
    },
  }),
}));
import { POST as changeOrder } from "../../orders/[id]/route";
import { POST as createOrder, GET as listOrders } from "../../orders/route";
import { GET as catalog, POST as savePackage } from "../route";

const definition = {
  id: "basic",
  name: "基础积分包",
  creditsMicro: "100000000",
  priceMinor: "990",
  currency: "CNY" as const,
  enabled: true,
};
const json = (path: string, body: unknown, key?: string) =>
  new Request(`http://test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify(body),
  });
const order = (key = "order-1", extra = {}) =>
  createOrder(
    json(
      "/api/billing/orders",
      {
        packageId: "basic",
        expectedVersion: 1,
        ...extra,
      },
      key,
    ),
  );
const action = (id: string, body: unknown) =>
  changeOrder(json(`/api/billing/orders/${id}`, body), {
    params: Promise.resolve({ id }),
  });

describe("package order HTTP contracts", () => {
  beforeEach(async () => {
    billing = new InMemoryBillingRepo();
    packages = new InMemoryPackageRepo(billing);
    state.userId = "alice";
    state.admin = false;
    state.apiKey = false;
    state.authenticated = true;
    await packages.save(definition, null, "staff");
  });
  it("catalog management and financial order actions do not inherit API key owner privileges", async () => {
    expect(
      (await savePackage(json("/api/billing/packages", { definition, expectedVersion: 1 }))).status,
    ).toBe(403);
    expect((await catalog(new Request("http://test/api/billing/packages?manage=1"))).status).toBe(
      403,
    );
    state.admin = true;
    state.apiKey = true;
    expect((await order()).status).toBe(403);
    expect((await listOrders(new Request("http://test/api/billing/orders"))).status).toBe(403);
    expect((await action("unknown", { action: "confirm", reason: "test" })).status).toBe(403);
  });
  it("creates a pending order, never lets the client set price, account or paid status", async () => {
    for (const extra of [{ priceMinor: "1" }, { accountId: "bob" }, { status: "credited" }]) {
      expect((await order("tamper", extra)).status).toBe(400);
    }
    const response = await order();
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      paymentMode: "manual",
      order: {
        accountId: "alice",
        priceMinor: "990",
        creditsMicro: "100000000",
        status: "pending",
      },
    });
    expect((await billing.balance("alice")).availableMicroCredits).toBe("0");
  });
  it("replays an accepted order after the package has changed and been disabled", async () => {
    const first = (await (await order()).json()).order;
    await packages.save({ ...definition, enabled: false, priceMinor: "1990" }, 1, "staff");
    const replay = await order();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      replayed: true,
      order: { id: first.id, priceMinor: "990" },
    });
    expect((await order("new-order")).status).toBeGreaterThanOrEqual(400);
  });
  it("isolates order history and prevents another customer cancelling or confirming", async () => {
    const id = (await (await order()).json()).order.id;
    state.userId = "bob";
    expect(
      (await (await listOrders(new Request("http://test/api/billing/orders"))).json()).items,
    ).toEqual([]);
    expect((await action(id, { action: "cancel" })).status).toBe(404);
    expect((await action(id, { action: "confirm", reason: "fake paid" })).status).toBe(403);
    expect((await listOrders(new Request("http://test/api/billing/orders?manage=1"))).status).toBe(
      403,
    );
  });
  it("administrator confirmation credits the frozen amount once, and credited orders cannot be cancelled", async () => {
    const id = (await (await order()).json()).order.id;
    state.admin = true;
    const first = await action(id, { action: "confirm", reason: "已人工核对" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      order: { status: "credited" },
      replayed: false,
      paymentMode: "manual",
    });
    const again = await action(id, { action: "confirm", reason: "再次确认" });
    expect((await again.json()).replayed).toBe(true);
    expect((await billing.balance("alice")).availableMicroCredits).toBe("100000000");
    expect((await billing.ledger("alice")).items).toHaveLength(1);
    state.admin = false;
    expect((await action(id, { action: "cancel" })).status).toBe(409);
  });
});
