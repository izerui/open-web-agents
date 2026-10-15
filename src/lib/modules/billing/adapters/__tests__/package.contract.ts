import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PackageDefinition, PackageRepo } from "../../package-ports";
import type { BillingRepo } from "../../ports";

export interface PackageFixture {
  repo: PackageRepo;
  billing: BillingRepo;
  packageId: string;
  otherPackageId: string;
  accountId: string;
  otherAccountId: string;
}

export const definition = (id: string): PackageDefinition => ({
  id,
  name: "Permanent credits",
  description: "Manual fulfillment",
  creditsMicro: "123456789012345678901",
  priceMinor: "1999",
  currency: "CNY",
  enabled: true,
});

export function packageContract(name: string, make: () => PackageFixture) {
  describe(name, () => {
    async function setup() {
      const h = make();
      const pack = await h.repo.save(definition(h.packageId), null, "admin");
      const request = {
        accountId: h.accountId,
        packageId: h.packageId,
        expectedVersion: pack.version,
        idempotencyKey: randomUUID(),
      };
      return { ...h, pack, request };
    }

    it.each(["\n", "\r", "\r\n", "\u2028", "\u2029", " ", "\t"])(
      "rejects leading/trailing whitespace in package IDs %# without normalizing it",
      async (whitespace) => {
        const h = make();
        for (const id of [`${h.packageId}${whitespace}`, `${whitespace}${h.packageId}`]) {
          await expect(h.repo.save(definition(id), null, "admin")).rejects.toMatchObject({
            status: 400,
            code: "invalid_request",
          });
          await expect(h.repo.get(id)).rejects.toMatchObject({ status: 400 });
          await expect(
            h.repo.createOrder({
              accountId: h.accountId,
              packageId: id,
              expectedVersion: 1,
              idempotencyKey: "invalid-id",
            }),
          ).rejects.toMatchObject({ status: 400 });
        }
        expect(await h.repo.get(h.packageId)).toBeNull();
        expect((await h.repo.listOrders({ accountId: h.accountId })).items).toEqual([]);
      },
    );

    it("saves exact monetary strings, filters disabled packages and protects optimistic versions", async () => {
      const h = await setup();
      expect(h.pack).toMatchObject({ ...definition(h.packageId), version: 1 });
      const disabled = await h.repo.save(
        { ...definition(h.packageId), enabled: false },
        1,
        "admin",
      );
      expect(disabled.version).toBe(2);
      expect((await h.repo.list()).some((p) => p.id === h.packageId)).toBe(false);
      expect((await h.repo.list(true)).some((p) => p.id === h.packageId)).toBe(true);
      expect(await h.repo.get(h.packageId)).toEqual(disabled);
      await expect(h.repo.save(definition(h.packageId), 1, "admin")).rejects.toMatchObject({
        status: 409,
        code: "package_changed",
      });
      await expect(h.repo.save(definition(h.packageId), null, "admin")).rejects.toMatchObject({
        status: 409,
      });
    });

    it("competing saves and first creates have one winner and one version", async () => {
      const h = make();
      const results = await Promise.allSettled([
        h.repo.save(definition(h.packageId), null, "admin"),
        h.repo.save({ ...definition(h.packageId), priceMinor: "2500" }, null, "admin"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { code: "package_changed" },
      });
      const updates = await Promise.allSettled([
        h.repo.save(definition(h.packageId), 1, "admin"),
        h.repo.save({ ...definition(h.packageId), priceMinor: "3000" }, 1, "admin"),
      ]);
      expect(updates.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await h.repo.get(h.packageId))?.version).toBe(2);
    });

    it("locks server-side package name, currency, price and credits into each order", async () => {
      const h = await setup();
      const created = await h.repo.createOrder(h.request);
      expect(created).toMatchObject({
        replayed: false,
        order: {
          accountId: h.accountId,
          packageId: h.packageId,
          packageVersion: 1,
          packageName: h.pack.name,
          creditsMicro: h.pack.creditsMicro,
          priceMinor: "1999",
          currency: "CNY",
          status: "pending",
        },
      });
      const changed = await h.repo.save(
        {
          ...definition(h.packageId),
          name: "New name",
          priceMinor: "9999",
          creditsMicro: "5",
          currency: "USD",
          enabled: false,
        },
        1,
        "admin",
      );
      expect(changed.version).toBe(2);
      expect(await h.repo.getOrder(created.order.id)).toEqual(created.order);
      const confirmed = await h.repo.confirmOrder(
        created.order.id,
        "admin",
        "Verified offline allocation",
      );
      expect(confirmed.order).toMatchObject({
        packageName: h.pack.name,
        creditsMicro: h.pack.creditsMicro,
        priceMinor: "1999",
        currency: "CNY",
      });
      expect((await h.billing.balance(h.accountId)).availableMicroCredits).toBe(
        h.pack.creditsMicro,
      );
    });

    it("replays before current enable/version checks, but mismatched same-key requests fail", async () => {
      const h = await setup();
      const first = await h.repo.createOrder(h.request);
      await h.repo.save({ ...definition(h.packageId), enabled: false }, 1, "admin");
      expect(await h.repo.createOrder(h.request)).toEqual({ order: first.order, replayed: true });
      await expect(h.repo.createOrder({ ...h.request, expectedVersion: 2 })).rejects.toMatchObject({
        status: 409,
        code: "idempotency_conflict",
      });
      await expect(
        h.repo.createOrder({
          ...h.request,
          packageId: h.otherPackageId,
        }),
      ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
      await expect(
        h.repo.createOrder({
          ...h.request,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 409, code: "package_disabled" });
      const cancelled = await h.repo.cancelOrder(first.order.id, h.accountId);
      expect(await h.repo.createOrder(h.request)).toEqual({ order: cancelled, replayed: true });
    });

    it("rejects stale price consent and unknown packages without creating an order", async () => {
      const h = await setup();
      await h.repo.save({ ...definition(h.packageId), priceMinor: "2000" }, 1, "admin");
      await expect(h.repo.createOrder(h.request)).rejects.toMatchObject({
        code: "package_changed",
      });
      await expect(
        h.repo.createOrder({
          ...h.request,
          packageId: h.otherPackageId,
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect((await h.repo.listOrders({ accountId: h.accountId })).items).toEqual([]);
    });

    it("concurrent duplicate creation returns a single order and account-scoped keys stay independent", async () => {
      const h = await setup();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => h.repo.createOrder(h.request)),
      );
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
      const other = await h.repo.createOrder({ ...h.request, accountId: h.otherAccountId });
      expect(other.replayed).toBe(false);
      expect(other.order.id).not.toBe(results[0]?.order.id);
      expect((await h.repo.listOrders({ accountId: h.accountId })).items).toHaveLength(1);
      expect((await h.billing.balance(h.accountId)).availableMicroCredits).toBe("0");
    });

    it("opaque idempotency keys remain case-sensitive", async () => {
      const h = await setup();
      const a = await h.repo.createOrder({ ...h.request, idempotencyKey: "Order-Key" });
      const b = await h.repo.createOrder({ ...h.request, idempotencyKey: "order-key" });
      expect(a.order.id).not.toBe(b.order.id);
    });

    it("concurrent confirmations fund once and preserve original actor/reason on later replay", async () => {
      const h = await setup();
      const { order } = await h.repo.createOrder(h.request);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => h.repo.confirmOrder(order.id, "admin", "Manual approval")),
      );
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.order.ledgerId)).size).toBe(1);
      const replay = await h.repo.confirmOrder(order.id, "second-admin", "Second request");
      expect(replay).toMatchObject({
        replayed: true,
        order: { status: "credited", creditedBy: "admin", confirmationReason: "Manual approval" },
      });
      expect(replay.order.creditedAt).toBeTypeOf("number");
      const ledger = await h.billing.ledger(h.accountId);
      expect(ledger.items).toHaveLength(1);
      expect(ledger.items[0]).toMatchObject({
        id: replay.order.ledgerId,
        kind: "credit",
        amountMicroCredits: h.pack.creditsMicro,
        reference: `package-order:${order.id}`,
        actorId: "admin",
        reason: "Manual approval",
      });
      expect((await h.billing.balance(h.accountId)).availableMicroCredits).toBe(
        h.pack.creditsMicro,
      );
      expect((await h.repo.createOrder(h.request)).order).toEqual(replay.order);
    });

    it("only the owning account can cancel pending orders; cancelled and credited states are final", async () => {
      const h = await setup();
      const { order } = await h.repo.createOrder(h.request);
      await expect(h.repo.cancelOrder(order.id, h.otherAccountId)).rejects.toMatchObject({
        status: 404,
      });
      expect((await h.repo.getOrder(order.id))?.status).toBe("pending");
      expect((await h.repo.cancelOrder(order.id, h.accountId)).status).toBe("cancelled");
      expect((await h.repo.cancelOrder(order.id, h.accountId)).status).toBe("cancelled");
      await expect(h.repo.confirmOrder(order.id, "admin", "Not allowed")).rejects.toMatchObject({
        status: 409,
        code: "order_cancelled",
      });
      expect((await h.billing.balance(h.accountId)).availableMicroCredits).toBe("0");
      const second = await h.repo.createOrder({ ...h.request, idempotencyKey: randomUUID() });
      await h.repo.confirmOrder(second.order.id, "admin", "Allocation");
      await expect(h.repo.cancelOrder(second.order.id, h.accountId)).rejects.toMatchObject({
        status: 409,
        code: "order_credited",
      });
    });

    it("confirmation and cancellation racing cannot both succeed", async () => {
      const h = await setup();
      const { order } = await h.repo.createOrder(h.request);
      const results = await Promise.allSettled([
        h.repo.confirmOrder(order.id, "admin", "Manual approval"),
        h.repo.cancelOrder(order.id, h.accountId),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { status: 409 },
      });
      const saved = await h.repo.getOrder(order.id);
      expect(["credited", "cancelled"]).toContain(saved?.status);
      expect((await h.billing.balance(h.accountId)).availableMicroCredits).toBe(
        saved?.status === "credited" ? h.pack.creditsMicro : "0",
      );
      expect((await h.billing.ledger(h.accountId)).items).toHaveLength(
        saved?.status === "credited" ? 1 : 0,
      );
    });

    it("wallet overflow leaves the order pending and does not append its credit", async () => {
      const h = await setup();
      await h.billing.credit({
        accountId: h.accountId,
        amountMicroCredits: "9".repeat(30),
        idempotencyKey: "max",
        actorId: "admin",
        reason: "Seed maximum",
      });
      const { order } = await h.repo.createOrder(h.request);
      await expect(h.repo.confirmOrder(order.id, "admin", "Allocation")).rejects.toMatchObject({
        code: "balance_overflow",
      });
      expect(await h.repo.getOrder(order.id)).toEqual(order);
      expect((await h.billing.ledger(h.accountId)).items).toHaveLength(1);
    });

    it("positive boundary amounts remain exact and no paid/expiry fields are synthesized", async () => {
      const h = make();
      await h.repo.save(
        {
          ...definition(h.packageId),
          creditsMicro: "9".repeat(30),
          priceMinor: "9".repeat(18),
          currency: "USD",
        },
        null,
        "admin",
      );
      const { order } = await h.repo.createOrder({
        accountId: h.accountId,
        packageId: h.packageId,
        expectedVersion: 1,
        idempotencyKey: "boundary",
      });
      expect(order.creditsMicro).toBe("9".repeat(30));
      expect(order.priceMinor).toBe("9".repeat(18));
      await h.repo.confirmOrder(order.id, "admin", "Manual allocation");
      expect((await h.billing.balance(h.accountId)).availableMicroCredits).toBe("9".repeat(30));
      expect(order).not.toHaveProperty("paid");
      expect(order).not.toHaveProperty("expiresAt");
    });

    it.each(["0", "-1", "1.5", "01", "+1", "1e3", "9".repeat(19), 100, null])(
      "rejects invalid or free package prices %#",
      async (priceMinor) => {
        const h = make();
        await expect(
          h.repo.save(
            { ...definition(h.packageId), priceMinor: priceMinor as string },
            null,
            "admin",
          ),
        ).rejects.toMatchObject({ status: 400, code: "invalid_amount" });
        expect(await h.repo.get(h.packageId)).toBeNull();
      },
    );

    it.each(["0", "-1", "1.5", "01", "9".repeat(31), 1, null])(
      "rejects invalid credit quantities %#",
      async (creditsMicro) => {
        const h = make();
        await expect(
          h.repo.save(
            {
              ...definition(h.packageId),
              creditsMicro: creditsMicro as string,
            },
            null,
            "admin",
          ),
        ).rejects.toMatchObject({ status: 400 });
      },
    );

    it("rejects forged order status/amount and malformed expected versions", async () => {
      const h = await setup();
      for (const extra of [
        { status: "credited" },
        { paid: true },
        { priceMinor: "1" },
        { creditsMicro: "999" },
      ]) {
        await expect(h.repo.createOrder({ ...h.request, ...extra })).rejects.toMatchObject({
          status: 400,
        });
      }
      for (const expectedVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
        await expect(h.repo.createOrder({ ...h.request, expectedVersion })).rejects.toMatchObject({
          status: 400,
        });
      }
      for (const bad of [
        { currency: "EUR" },
        { enabled: "yes" },
        { name: "" },
        { name: "x".repeat(121) },
        { description: "x".repeat(1025) },
        { expiresAt: Date.now() },
      ]) {
        await expect(
          h.repo.save({ ...definition(h.packageId), ...bad } as PackageDefinition, 1, "admin"),
        ).rejects.toMatchObject({ status: 400 });
      }
      expect((await h.repo.listOrders({ accountId: h.accountId })).items).toEqual([]);
    });

    it("requires confirmation explanation and never writes on invalid confirmations", async () => {
      const h = await setup();
      const { order } = await h.repo.createOrder(h.request);
      for (const [actorId, reason] of [
        ["admin", ""],
        ["admin", " "],
        ["", "Approval"],
        ["admin", "x".repeat(513)],
      ]) {
        await expect(
          h.repo.confirmOrder(order.id, actorId ?? "", reason ?? ""),
        ).rejects.toMatchObject({ status: 400 });
      }
      expect(await h.repo.getOrder(order.id)).toEqual(order);
      expect((await h.billing.ledger(h.accountId)).items).toEqual([]);
      const unknown = randomUUID();
      expect(await h.repo.getOrder(unknown)).toBeNull();
      await expect(h.repo.cancelOrder(unknown, h.accountId)).rejects.toMatchObject({ status: 404 });
      await expect(h.repo.confirmOrder(unknown, "admin", "Approval")).rejects.toMatchObject({
        status: 404,
      });
    });

    it("account-scoped stable pagination handles equal timestamps and later inserts", async () => {
      const h = await setup();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        for (let n = 0; n < 5; n++)
          await h.repo.createOrder({ ...h.request, idempotencyKey: `page-${n}` });
        const first = await h.repo.listOrders({ accountId: h.accountId, limit: 2 });
        expect(first.nextCursor).toBeTruthy();
        clock.mockReturnValue(1001);
        const later = await h.repo.createOrder({ ...h.request, idempotencyKey: "newer" });
        const seen = [...first.items];
        let cursor = first.nextCursor;
        while (cursor) {
          const page = await h.repo.listOrders({ accountId: h.accountId, limit: 2, cursor });
          seen.push(...page.items);
          cursor = page.nextCursor;
        }
        expect(seen).toHaveLength(5);
        expect(new Set(seen.map((o) => o.id)).size).toBe(5);
        expect(seen.some((o) => o.id === later.order.id)).toBe(false);
        expect(seen.map((o) => o.id)).toEqual(
          seen
            .map((o) => o.id)
            .sort()
            .reverse(),
        );
        await expect(
          h.repo.listOrders({
            accountId: h.otherAccountId,
            cursor: first.nextCursor,
          }),
        ).rejects.toMatchObject({ code: "invalid_cursor" });
        await expect(h.repo.listOrders({ cursor: first.nextCursor })).rejects.toMatchObject({
          code: "invalid_cursor",
        });
        expect((await h.repo.listOrders({ accountId: h.otherAccountId })).items).toEqual([]);
      } finally {
        clock.mockRestore();
      }
      for (const limit of [0, 101, 1.5]) {
        await expect(h.repo.listOrders({ limit })).rejects.toMatchObject({ status: 400 });
      }
      await expect(h.repo.listOrders({ cursor: "bad" })).rejects.toMatchObject({
        code: "invalid_cursor",
      });
    });

    it("returned definitions/orders cannot mutate stored snapshots", async () => {
      const h = await setup();
      h.pack.creditsMicro = "1";
      const result = await h.repo.createOrder(h.request);
      result.order.creditsMicro = "1";
      const rows = await h.repo.listOrders({ accountId: h.accountId });
      for (const row of rows.items) row.priceMinor = "1";
      expect((await h.repo.get(h.packageId))?.creditsMicro).toBe(
        definition(h.packageId).creditsMicro,
      );
      expect((await h.repo.getOrder(result.order.id))?.priceMinor).toBe("1999");
      await h.repo.confirmOrder(result.order.id, "admin", "Approval");
      expect((await h.billing.balance(h.accountId)).availableMicroCredits).toBe(
        definition(h.packageId).creditsMicro,
      );
    });
  });
}
