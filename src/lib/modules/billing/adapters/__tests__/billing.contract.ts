import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_MICRO_CREDITS } from "../../domain/wallet";
import type { BillingRepo, BillingRepoOptions, CreditRequest } from "../../ports";

export interface BillingFixture {
  repo: BillingRepo;
  accountId: string;
  otherAccountId: string;
}

export function billingContract(
  name: string,
  make: (options?: BillingRepoOptions) => BillingFixture,
) {
  const credit = (
    accountId: string,
    amountMicroCredits = "100",
    idempotencyKey: string = randomUUID(),
  ): CreditRequest => ({
    accountId,
    amountMicroCredits,
    idempotencyKey,
    actorId: "admin",
    reason: "Test funding",
  });
  describe(name, () => {
    it("findCredit returns the entry for that account and key only, without changing balances", async () => {
      const { repo, accountId } = make();
      const key = randomUUID();
      expect(await repo.findCredit(accountId, key)).toBeNull();
      const { entry } = await repo.credit(credit(accountId, "100", key));
      expect(await repo.findCredit(accountId, key)).toEqual(entry);
      expect(await repo.findCredit(accountId, randomUUID())).toBeNull();
      expect(await repo.findCredit(randomUUID(), key)).toBeNull();
      expect((await repo.balance(accountId)).availableMicroCredits).toBe("100");
    });

    it("missing accounts read as zero with no ledger", async () => {
      const { repo, accountId } = make();
      expect(await repo.balance(accountId)).toEqual({
        accountId,
        availableMicroCredits: "0",
        reservedMicroCredits: "0",
      });
      expect(await repo.ledger(accountId)).toEqual({ items: [] });
      await expect(
        repo.reserve({ accountId, reservationId: randomUUID(), amountMicroCredits: "1" }),
      ).rejects.toMatchObject({ code: "insufficient_balance" });
      expect((await repo.balance(accountId)).availableMicroCredits).toBe("0");
    });

    it("returned objects cannot mutate persisted balances, ledger entries or reservations", async () => {
      const { repo, accountId } = make();
      const input = credit(accountId);
      const funded = await repo.credit(input);
      funded.balance.availableMicroCredits = "999";
      funded.entry.availableAfter = "999";
      const held = await repo.reserve({
        accountId,
        reservationId: randomUUID(),
        amountMicroCredits: "25",
      });
      const id = held.id;
      held.amountMicroCredits = "999";
      const page = await repo.ledger(accountId);
      for (const entry of page.items) entry.amountMicroCredits = "999";
      expect((await repo.credit(input)).entry.amountMicroCredits).toBe("100");
      await repo.settle({ accountId, reservationId: id, chargedMicroCredits: "10" });
      expect(await repo.balance(accountId)).toMatchObject({
        availableMicroCredits: "90",
        reservedMicroCredits: "0",
      });
    });

    it("credits preserve integers beyond JS safe range and retain original metadata", async () => {
      const { repo, accountId } = make();
      const amount = "900719925474099312345678";
      const result = await repo.credit(credit(accountId, amount));
      expect(result.balance.availableMicroCredits).toBe(amount);
      expect(result.entry).toMatchObject({
        accountId,
        kind: "credit",
        amountMicroCredits: amount,
        availableAfter: amount,
        reservedAfter: "0",
        actorId: "admin",
        reason: "Test funding",
      });
      expect(result.replayed).toBe(false);
      expect((await repo.credit(credit(accountId, "1"))).balance.availableMicroCredits).toBe(
        "900719925474099312345679",
      );
    });

    it("concurrent same-key credits apply exactly once; replay returns original entry and current balance", async () => {
      const { repo, accountId } = make();
      const request = credit(accountId);
      const results = await Promise.all(Array.from({ length: 12 }, () => repo.credit(request)));
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(new Set(results.map((result) => result.entry.id)).size).toBe(1);
      await repo.credit(credit(accountId, "7"));
      const replay = await repo.credit(request);
      expect(replay.balance.availableMicroCredits).toBe("107");
      expect(replay.entry.availableAfter).toBe("100");
      expect((await repo.ledger(accountId)).items).toHaveLength(2);
    });

    it.each([
      { amountMicroCredits: "101" },
      { actorId: "other-admin" },
      { reason: "Changed reason" },
    ])("same-key different content is a 409 with unchanged balances: %j", async (change) => {
      const { repo, accountId } = make();
      const request = credit(accountId);
      await repo.credit(request);
      await expect(repo.credit({ ...request, ...change })).rejects.toMatchObject({
        status: 409,
        code: "idempotency_conflict",
      });
      expect((await repo.balance(accountId)).availableMicroCredits).toBe("100");
      expect((await repo.ledger(accountId)).items).toHaveLength(1);
    });

    it("keys and accounts are case-sensitive and idempotency is scoped by account", async () => {
      const { repo, accountId, otherAccountId } = make();
      await repo.credit(credit(accountId, "5", "Credit-Key"));
      await repo.credit(credit(accountId, "7", "credit-key"));
      await repo.credit(credit(otherAccountId, "11", "Credit-Key"));
      expect((await repo.balance(accountId)).availableMicroCredits).toBe("12");
      expect((await repo.balance(otherAccountId)).availableMicroCredits).toBe("11");
    });

    it("atomically moves available to reserved, settles actual cost and releases unused amount", async () => {
      const { repo, accountId } = make();
      await repo.credit(credit(accountId));
      const reservationId = randomUUID();
      const reserved = await repo.reserve({ accountId, reservationId, amountMicroCredits: "70" });
      expect(reserved).toEqual({
        id: reservationId,
        accountId,
        amountMicroCredits: "70",
        state: "reserved",
      });
      expect(await repo.balance(accountId)).toMatchObject({
        availableMicroCredits: "30",
        reservedMicroCredits: "70",
      });
      const settled = await repo.settle({ accountId, reservationId, chargedMicroCredits: "40" });
      expect(settled).toMatchObject({ state: "settled", chargedMicroCredits: "40" });
      expect(await repo.balance(accountId)).toMatchObject({
        availableMicroCredits: "60",
        reservedMicroCredits: "0",
      });
      const entries = (await repo.ledger(accountId)).items;
      expect(entries).toHaveLength(3);
      expect(entries.find((e) => e.kind === "reserve")).toMatchObject({
        reference: reservationId,
        amountMicroCredits: "70",
        availableAfter: "30",
        reservedAfter: "70",
      });
      expect(entries.find((e) => e.kind === "settle")).toMatchObject({
        reference: reservationId,
        amountMicroCredits: "40",
        availableAfter: "60",
        reservedAfter: "0",
      });
    });

    it("zero-charge settlement releases the entire reservation once", async () => {
      const { repo, accountId } = make();
      await repo.credit(credit(accountId));
      const reservationId = randomUUID();
      await repo.reserve({ accountId, reservationId, amountMicroCredits: "100" });
      await repo.settle({ accountId, reservationId, chargedMicroCredits: "0" });
      await repo.settle({ accountId, reservationId, chargedMicroCredits: "0" });
      expect(await repo.balance(accountId)).toMatchObject({
        availableMicroCredits: "100",
        reservedMicroCredits: "0",
      });
      expect((await repo.ledger(accountId)).items).toHaveLength(3);
    });

    it("concurrent reservations cannot spend the same available balance", async () => {
      const { repo, accountId } = make();
      await repo.credit(credit(accountId));
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          repo.reserve({ accountId, reservationId: randomUUID(), amountMicroCredits: "10" }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
      for (const result of results) {
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({
            status: 402,
            code: "insufficient_balance",
          });
      }
      expect(await repo.balance(accountId)).toMatchObject({
        availableMicroCredits: "0",
        reservedMicroCredits: "100",
      });
      expect((await repo.ledger(accountId)).items).toHaveLength(11);
    });

    it("duplicate reservation and settlement callbacks neither freeze nor charge twice", async () => {
      const { repo, accountId } = make();
      await repo.credit(credit(accountId));
      const request = { accountId, reservationId: randomUUID(), amountMicroCredits: "70" };
      const reservations = await Promise.all(
        Array.from({ length: 10 }, () => repo.reserve(request)),
      );
      expect(reservations.every((r) => r.state === "reserved")).toBe(true);
      const settlements = await Promise.all(
        Array.from({ length: 10 }, () => repo.settle({ ...request, chargedMicroCredits: "40" })),
      );
      expect(settlements.every((r) => r.chargedMicroCredits === "40")).toBe(true);
      expect(await repo.reserve(request)).toMatchObject({
        state: "settled",
        chargedMicroCredits: "40",
      });
      await expect(
        repo.reserve({
          ...request,
          amountMicroCredits: "71",
        }),
      ).rejects.toMatchObject({ code: "reservation_conflict" });
      await expect(
        repo.settle({
          ...request,
          chargedMicroCredits: "41",
        }),
      ).rejects.toMatchObject({ code: "settlement_conflict" });
      expect(await repo.balance(accountId)).toMatchObject({
        availableMicroCredits: "60",
        reservedMicroCredits: "0",
      });
      expect((await repo.ledger(accountId)).items).toHaveLength(3);
    });

    it("different concurrent settlement amounts have exactly one winner", async () => {
      const { repo, accountId } = make();
      await repo.credit(credit(accountId));
      const reservationId = randomUUID();
      await repo.reserve({ accountId, reservationId, amountMicroCredits: "80" });
      const results = await Promise.allSettled(
        ["30", "40"].map((chargedMicroCredits) =>
          repo.settle({ accountId, reservationId, chargedMicroCredits }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const winner = results.find((r) => r.status === "fulfilled");
      if (winner?.status !== "fulfilled" || winner.value.chargedMicroCredits === undefined)
        throw new Error("missing settlement");
      expect((await repo.balance(accountId)).availableMicroCredits).toBe(
        (100n - BigInt(winner.value.chargedMicroCredits)).toString(),
      );
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { code: "settlement_conflict" },
      });
      expect((await repo.ledger(accountId)).items).toHaveLength(3);
    });

    it("global reservation IDs cannot be reused or settled across accounts", async () => {
      const { repo, accountId, otherAccountId } = make();
      await repo.credit(credit(accountId));
      await repo.credit(credit(otherAccountId));
      const reservationId = randomUUID();
      await repo.reserve({ accountId, reservationId, amountMicroCredits: "50" });
      await expect(
        repo.reserve({ accountId: otherAccountId, reservationId, amountMicroCredits: "50" }),
      ).rejects.toMatchObject({ code: "reservation_conflict" });
      await expect(
        repo.settle({ accountId: otherAccountId, reservationId, chargedMicroCredits: "0" }),
      ).rejects.toMatchObject({ code: "reservation_conflict" });
      expect(await repo.balance(otherAccountId)).toMatchObject({
        availableMicroCredits: "100",
        reservedMicroCredits: "0",
      });
    });

    it("cross-account contention for the same reservation commits only one hold", async () => {
      const { repo, accountId, otherAccountId } = make();
      await repo.credit(credit(accountId));
      await repo.credit(credit(otherAccountId));
      const reservationId = randomUUID();
      const results = await Promise.allSettled(
        [accountId, otherAccountId].map((id) =>
          repo.reserve({ accountId: id, reservationId, amountMicroCredits: "50" }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { code: "reservation_conflict" },
      });
      const balances = await Promise.all([repo.balance(accountId), repo.balance(otherAccountId)]);
      expect(balances.map((b) => b.reservedMicroCredits).sort()).toEqual(["0", "50"]);
      expect(
        (await repo.ledger(accountId)).items.length +
          (await repo.ledger(otherAccountId)).items.length,
      ).toBe(3);
    });

    it("unknown or excessive charges leave a valid reservation untouched", async () => {
      const { repo, accountId } = make();
      await repo.credit(credit(accountId));
      await expect(
        repo.settle({ accountId, reservationId: randomUUID(), chargedMicroCredits: "0" }),
      ).rejects.toMatchObject({ status: 404, code: "reservation_not_found" });
      const request = { accountId, reservationId: randomUUID(), amountMicroCredits: "30" };
      await repo.reserve(request);
      await expect(
        repo.settle({
          ...request,
          chargedMicroCredits: "31",
        }),
      ).rejects.toMatchObject({ code: "charge_exceeds_reservation" });
      expect(await repo.reserve(request)).toMatchObject({ state: "reserved" });
      expect(await repo.balance(accountId)).toMatchObject({
        availableMicroCredits: "70",
        reservedMicroCredits: "30",
      });
      expect((await repo.ledger(accountId)).items).toHaveLength(2);
    });

    it.each(["0", "-1", "1.2", "1e6", "+1", "01", " 1", "1 ", "", "9".repeat(31), 1, null])(
      "rejects invalid/zero credit and reserve amounts %# without creating ledger rows",
      async (raw) => {
        const { repo, accountId } = make();
        await expect(repo.credit(credit(accountId, raw as string))).rejects.toMatchObject({
          status: 400,
          code: "invalid_amount",
        });
        await expect(
          repo.reserve({
            accountId,
            reservationId: randomUUID(),
            amountMicroCredits: raw as string,
          }),
        ).rejects.toMatchObject({ status: 400, code: "invalid_amount" });
        expect((await repo.balance(accountId)).availableMicroCredits).toBe("0");
        expect((await repo.ledger(accountId)).items).toEqual([]);
      },
    );

    it.each(["-1", "01", "1.5", "1e2", "9".repeat(31), 0, null])(
      "rejects invalid settlement amounts %#",
      async (raw) => {
        const { repo, accountId } = make();
        await expect(
          repo.settle({
            accountId,
            reservationId: randomUUID(),
            chargedMicroCredits: raw as string,
          }),
        ).rejects.toMatchObject({ status: 400, code: "invalid_amount" });
      },
    );

    it("overflow checks include reserved funds so a later release always fits", async () => {
      const { repo, accountId } = make();
      const max = MAX_MICRO_CREDITS.toString();
      await repo.credit(credit(accountId, max));
      await expect(repo.credit(credit(accountId, "1"))).rejects.toMatchObject({
        code: "balance_overflow",
      });
      const reservationId = randomUUID();
      await repo.reserve({ accountId, reservationId, amountMicroCredits: max });
      await expect(repo.credit(credit(accountId, "1"))).rejects.toMatchObject({
        code: "balance_overflow",
      });
      await repo.settle({ accountId, reservationId, chargedMicroCredits: "0" });
      expect(await repo.balance(accountId)).toMatchObject({
        availableMicroCredits: max,
        reservedMicroCredits: "0",
      });
      expect((await repo.ledger(accountId)).items).toHaveLength(3);
    });

    it("stable createdAt+id pagination handles ties, new entries and account scoping", async () => {
      let now = 1000;
      let sequence = 0;
      const prefix = randomUUID().slice(0, 24);
      const { repo, accountId, otherAccountId } = make({
        now: () => now,
        entryId: () => `${prefix}${(++sequence).toString().padStart(8, "0")}`,
      });
      for (let i = 0; i < 5; i++) await repo.credit(credit(accountId, "1"));
      const first = await repo.ledger(accountId, { limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBeTruthy();
      now++;
      const later = await repo.credit(credit(accountId, "1"));
      const seen = [...first.items];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = await repo.ledger(accountId, { limit: 2, cursor });
        seen.push(...page.items);
        cursor = page.nextCursor;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen.map((e) => e.id)).size).toBe(5);
      expect(seen.some((e) => e.id === later.entry.id)).toBe(false);
      expect(seen.map((e) => e.id)).toEqual(
        seen
          .map((e) => e.id)
          .sort()
          .reverse(),
      );
      await expect(repo.ledger(otherAccountId, { cursor: first.nextCursor })).rejects.toMatchObject(
        { code: "invalid_cursor" },
      );
      await expect(repo.ledger(accountId, { cursor: "bad" })).rejects.toMatchObject({
        code: "invalid_cursor",
      });
      for (const limit of [0, 101, 1.5, Number.NaN]) {
        await expect(repo.ledger(accountId, { limit })).rejects.toMatchObject({
          code: "invalid_request",
        });
      }
    });

    it("ledger ID collisions roll back credit, reservation and settlement mutations", async () => {
      let entryId = randomUUID();
      const { repo, accountId } = make({ entryId: () => entryId });
      await repo.credit(credit(accountId));
      const collision = entryId;
      const failingCredit = credit(accountId, "10");
      await expect(repo.credit(failingCredit)).rejects.toMatchObject({ code: "ledger_conflict" });
      expect((await repo.balance(accountId)).availableMicroCredits).toBe("100");
      const request = { accountId, reservationId: randomUUID(), amountMicroCredits: "70" };
      await expect(repo.reserve(request)).rejects.toMatchObject({ code: "ledger_conflict" });
      expect(await repo.balance(accountId)).toMatchObject({
        availableMicroCredits: "100",
        reservedMicroCredits: "0",
      });
      entryId = randomUUID();
      expect(await repo.reserve(request)).toMatchObject({ state: "reserved" });
      entryId = collision;
      await expect(
        repo.settle({
          ...request,
          chargedMicroCredits: "40",
        }),
      ).rejects.toMatchObject({ code: "ledger_conflict" });
      expect(await repo.balance(accountId)).toMatchObject({
        availableMicroCredits: "30",
        reservedMicroCredits: "70",
      });
      expect(await repo.reserve(request)).toMatchObject({ state: "reserved" });
      expect((await repo.ledger(accountId)).items).toHaveLength(2);
      entryId = randomUUID();
      await repo.settle({ ...request, chargedMicroCredits: "40" });
      entryId = randomUUID();
      expect((await repo.credit(failingCredit)).replayed).toBe(false);
      expect(await repo.balance(accountId)).toMatchObject({
        availableMicroCredits: "70",
        reservedMicroCredits: "0",
      });
      expect((await repo.ledger(accountId)).items).toHaveLength(4);
    });

    it("invalid identifiers and missing idempotency metadata cannot create money", async () => {
      const { repo, accountId } = make();
      for (const change of [
        { accountId: "" },
        { accountId: "a".repeat(37) },
        { actorId: "" },
        { idempotencyKey: "" },
        { idempotencyKey: "k".repeat(129) },
        { reason: "" },
        { reason: "r".repeat(513) },
      ]) {
        await expect(repo.credit({ ...credit(accountId), ...change })).rejects.toMatchObject({
          status: 400,
        });
      }
      await expect(
        repo.reserve({ accountId, reservationId: "", amountMicroCredits: "1" }),
      ).rejects.toMatchObject({ status: 400 });
      expect((await repo.ledger(accountId)).items).toEqual([]);
    });
  });
}
