import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { billingLedger, billingReservations, billingWallets } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { billingKey } from "../../domain/wallet";
import { MysqlBillingRepo } from "../mysql-billing-repo";
import { billingContract } from "./billing.contract";

const url = process.env.OWA_TEST_DATABASE_URL;
if (url && new URL(url).pathname !== "/owa_test") {
  throw new Error("Billing SQL tests require the dedicated owa_test database");
}
if (!url) {
  describe.skip("MysqlBillingRepo (requires owa_test)", () => {
    it("not configured", () => {});
  });
} else {
  const { db, pool } = createDb(url);
  const accounts = new Set<string>();

  function ids() {
    const accountId = `billing-${randomUUID().slice(0, 24)}`;
    const otherAccountId = accountId.toUpperCase();
    accounts.add(accountId);
    accounts.add(otherAccountId);
    return { accountId, otherAccountId };
  }

  billingContract("MysqlBillingRepo", (options) => ({
    repo: new MysqlBillingRepo(db, options),
    ...ids(),
  }));
  afterAll(async () => {
    try {
      const keys = [...accounts].map((accountId) => billingKey(accountId));
      if (keys.length) {
        // 不清表、不删用户,仅清理由本文件创建的随机账户账务记录。
        await db.delete(billingLedger).where(inArray(billingLedger.accountKey, keys));
        await db
          .delete(billingReservations)
          .where(inArray(billingReservations.accountId, [...accounts]));
        await db.delete(billingWallets).where(inArray(billingWallets.accountKey, keys));
      }
    } finally {
      await pool.end();
    }
  });

  describe("SQL transaction rollback", () => {
    it("failure of the first ledger insert rolls back creation of the new wallet row", async () => {
      const { accountId, otherAccountId } = ids();
      const entryId = randomUUID();
      const repo = new MysqlBillingRepo(db, { entryId: () => entryId });
      const input = {
        amountMicroCredits: "5",
        idempotencyKey: "fund",
        actorId: "admin",
        reason: "test",
      };
      await repo.credit({ ...input, accountId });
      await expect(
        repo.credit({
          ...input,
          accountId: otherAccountId,
        }),
      ).rejects.toMatchObject({ code: "ledger_conflict" });
      expect(
        await db
          .select()
          .from(billingWallets)
          .where(eq(billingWallets.accountKey, billingKey(otherAccountId))),
      ).toEqual([]);
      expect((await repo.ledger(otherAccountId)).items).toEqual([]);
      const fresh = new MysqlBillingRepo(db);
      expect((await fresh.credit({ ...input, accountId: otherAccountId })).replayed).toBe(false);
      expect((await fresh.balance(otherAccountId)).availableMicroCredits).toBe("5");
    });
  });
}
