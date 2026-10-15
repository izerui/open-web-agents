import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BillingError } from "../../ports";
import { InMemoryBillingRepo } from "../in-memory-billing-repo";
import { InMemoryPackageRepo } from "../in-memory-package-repo";
import { definition, packageContract } from "./package.contract";

function fixture() {
  const billing = new InMemoryBillingRepo();
  const accountId = `pkg-${randomUUID().slice(0, 24)}`;
  return {
    repo: new InMemoryPackageRepo(billing),
    billing,
    accountId,
    otherAccountId: accountId.toUpperCase(),
    packageId: `pkg-${randomUUID()}`,
    otherPackageId: `pkg-${randomUUID()}`,
  };
}

packageContract("InMemoryPackageRepo", fixture);

describe("in-memory order locking", () => {
  const gate = () => {
    let open = () => {};
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, wait };
  };

  it("cancel waits across the await credit boundary and cannot cancel a funded order", async () => {
    const h = fixture();
    await h.repo.save(definition(h.packageId), null, "admin");
    const { order } = await h.repo.createOrder({
      accountId: h.accountId,
      packageId: h.packageId,
      expectedVersion: 1,
      idempotencyKey: "fund",
    });
    const reached = gate();
    const release = gate();
    const original = h.billing.credit.bind(h.billing);
    vi.spyOn(h.billing, "credit").mockImplementation(async (input) => {
      const result = await original(input);
      reached.open();
      await release.wait;
      return result;
    });
    const confirming = h.repo.confirmOrder(order.id, "admin", "Approval");
    await reached.wait;
    let cancelledFinished = false;
    const cancelling = h.repo.cancelOrder(order.id, h.accountId).then(
      (value) => {
        cancelledFinished = true;
        return { value, error: undefined };
      },
      (error: unknown) => {
        cancelledFinished = true;
        return { value: undefined, error };
      },
    );
    try {
      await Promise.resolve();
      expect(cancelledFinished).toBe(false);
      expect((await h.repo.getOrder(order.id))?.status).toBe("pending");
    } finally {
      release.open();
    }
    expect((await confirming).order.status).toBe("credited");
    expect((await cancelling).error).toMatchObject({ code: "order_credited" });
    expect((await h.billing.ledger(h.accountId)).items).toHaveLength(1);
  });

  it("wallet rejection keeps order pending and does not poison its lock queue", async () => {
    const h = fixture();
    await h.repo.save(definition(h.packageId), null, "admin");
    const { order } = await h.repo.createOrder({
      accountId: h.accountId,
      packageId: h.packageId,
      expectedVersion: 1,
      idempotencyKey: "fund",
    });
    vi.spyOn(h.billing, "credit").mockRejectedValueOnce(
      new BillingError(409, "ledger_conflict", "test failure"),
    );
    await expect(h.repo.confirmOrder(order.id, "admin", "Approval")).rejects.toMatchObject({
      code: "ledger_conflict",
    });
    expect(await h.repo.getOrder(order.id)).toEqual(order);
    expect((await h.repo.confirmOrder(order.id, "admin", "Approval")).order.status).toBe(
      "credited",
    );
    expect((await h.billing.ledger(h.accountId)).items).toHaveLength(1);
  });
});
