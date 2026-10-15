import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import {
  billingLedger,
  billingWallets,
  creditOrders,
  creditPackageVersions,
  creditPackages,
} from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { billingKey } from "../../domain/wallet";
import { MysqlBillingRepo } from "../mysql-billing-repo";
import { MysqlPackageRepo } from "../mysql-package-repo";
import { definition, packageContract } from "./package.contract";

const url = process.env.OWA_TEST_DATABASE_URL;
if (url && new URL(url).pathname !== "/owa_test")
  throw new Error("Package SQL tests require owa_test");
if (!url) {
  describe.skip("MysqlPackageRepo (requires owa_test)", () => {
    it("not configured", () => {});
  });
} else {
  const { db, pool } = createDb(url);
  const accounts = new Set<string>();
  const packages = new Set<string>();

  function fixture() {
    const accountId = `pkg-${randomUUID().slice(0, 24)}`;
    const otherAccountId = accountId.toUpperCase();
    const packageId = `pkg-${randomUUID()}`;
    const otherPackageId = `pkg-${randomUUID()}`;
    for (const id of [accountId, otherAccountId]) accounts.add(id);
    for (const id of [packageId, otherPackageId]) packages.add(id);
    return {
      repo: new MysqlPackageRepo(db),
      billing: new MysqlBillingRepo(db),
      accountId,
      otherAccountId,
      packageId,
      otherPackageId,
    };
  }

  packageContract("MysqlPackageRepo", fixture);
  afterAll(async () => {
    try {
      const keys = [...accounts].map((id) => billingKey(id));
      if (keys.length) {
        await db.delete(creditOrders).where(inArray(creditOrders.accountKey, keys));
        await db.delete(billingLedger).where(inArray(billingLedger.accountKey, keys));
        await db.delete(billingWallets).where(inArray(billingWallets.accountKey, keys));
      }
      if (packages.size) {
        await db
          .delete(creditPackageVersions)
          .where(inArray(creditPackageVersions.packageId, [...packages]));
        await db.delete(creditPackages).where(inArray(creditPackages.id, [...packages]));
      }
    } finally {
      await pool.end();
    }
  });

  describe("package SQL atomicity", () => {
    it("failure after wallet credit succeeds rolls back BOTH the order and money", async () => {
      const h = fixture();
      await h.repo.save(definition(h.packageId), null, "admin");
      const { order } = await h.repo.createOrder({
        accountId: h.accountId,
        packageId: h.packageId,
        expectedVersion: 1,
        idempotencyKey: "fund",
      });
      const original = MysqlBillingRepo.prototype.credit;
      let creditSucceeded = false;
      const spy = vi.spyOn(MysqlBillingRepo.prototype, "credit").mockImplementation(async function (
        this: MysqlBillingRepo,
        input,
      ) {
        const result = await original.call(this, input);
        expect(result.entry.amountMicroCredits).toBe(order.creditsMicro);
        creditSucceeded = true;
        throw new Error("forced failure after wallet credit");
      });
      try {
        await expect(h.repo.confirmOrder(order.id, "admin", "Allocation")).rejects.toThrow(
          "forced failure after wallet credit",
        );
      } finally {
        spy.mockRestore();
      }
      expect(creditSucceeded).toBe(true);
      expect(await h.repo.getOrder(order.id)).toEqual(order);
      expect((await h.billing.balance(h.accountId)).availableMicroCredits).toBe("0");
      expect((await h.billing.ledger(h.accountId)).items).toEqual([]);
      expect(
        await db
          .select()
          .from(billingWallets)
          .where(eq(billingWallets.accountKey, billingKey(h.accountId))),
      ).toEqual([]);
      // 改为 MysqlBillingRepo(外部db)时上面断言会失败,因为钱包已经单独提交。
      expect((await h.repo.confirmOrder(order.id, "admin", "Allocation")).replayed).toBe(false);
      expect((await h.billing.ledger(h.accountId)).items).toHaveLength(1);
    });

    it("saving updates the current package but never mutates prior version snapshots", async () => {
      const h = fixture();
      await h.repo.save(definition(h.packageId), null, "admin");
      const before = await db
        .select()
        .from(creditPackageVersions)
        .where(
          and(
            eq(creditPackageVersions.packageId, h.packageId),
            eq(creditPackageVersions.version, 1),
          ),
        );
      await h.repo.save(
        {
          ...definition(h.packageId),
          creditsMicro: "10",
          priceMinor: "500",
          enabled: false,
        },
        1,
        "admin",
      );
      const after = await db
        .select()
        .from(creditPackageVersions)
        .where(
          and(
            eq(creditPackageVersions.packageId, h.packageId),
            eq(creditPackageVersions.version, 1),
          ),
        );
      expect(after).toEqual(before);
      expect(
        await db
          .select()
          .from(creditPackageVersions)
          .where(eq(creditPackageVersions.packageId, h.packageId)),
      ).toHaveLength(2);
    });

    it("version insertion failure rolls the current definition back", async () => {
      const h = fixture();
      const first = await h.repo.save(definition(h.packageId), null, "admin");
      await db.insert(creditPackageVersions).values({
        packageId: h.packageId,
        version: 2,
        definition: definition(h.packageId),
        createdBy: "test-blocker",
        createdAt: Date.now(),
      });
      await expect(
        h.repo.save({ ...definition(h.packageId), priceMinor: "2500" }, 1, "admin"),
      ).rejects.toMatchObject({ code: "package_changed" });
      expect(await h.repo.get(h.packageId)).toEqual(first);
    });
  });
}
