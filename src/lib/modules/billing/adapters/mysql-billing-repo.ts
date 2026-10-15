import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/client";
import { billingLedger, billingReservations, billingWallets } from "@/lib/db/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
import {
  accountOf,
  assertCreditReplay,
  assertReserveReplay,
  assertSettleReplay,
  billingKey,
  creditBalance,
  emptyWallet,
  entryOf,
  ledgerPage,
  ledgerQuery,
  reserveBalance,
  settleBalance,
  validateCredit,
  validateReserve,
  validateSettle,
} from "../domain/wallet";
import {
  BillingError,
  type BillingRepo,
  type BillingRepoOptions,
  type CreditRequest,
  type LedgerEntry,
  type LedgerQuery,
  type Reservation,
  type ReserveRequest,
  type SettleRequest,
  type WalletBalance,
} from "../ports";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function walletOf(row: typeof billingWallets.$inferSelect): WalletBalance {
  return {
    accountId: row.accountId,
    availableMicroCredits: row.availableMicroCredits,
    reservedMicroCredits: row.reservedMicroCredits,
  };
}

function ledgerOf(row: typeof billingLedger.$inferSelect): LedgerEntry {
  return {
    id: row.id,
    accountId: row.accountId,
    kind: row.kind as LedgerEntry["kind"],
    amountMicroCredits: row.amountMicroCredits,
    availableAfter: row.availableAfter,
    reservedAfter: row.reservedAfter,
    reference: row.reference,
    createdAt: row.createdAt,
    ...(row.actorId !== null ? { actorId: row.actorId } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
  };
}

function reservationOf(row: typeof billingReservations.$inferSelect): Reservation {
  return {
    id: row.id,
    accountId: row.accountId,
    amountMicroCredits: row.amountMicroCredits,
    state: row.state as Reservation["state"],
    ...(row.chargedMicroCredits !== null ? { chargedMicroCredits: row.chargedMicroCredits } : {}),
  };
}

function duplicate(error: unknown): boolean {
  const value = error as { code?: string; cause?: { code?: string } } | null;
  return (value?.code ?? value?.cause?.code) === "ER_DUP_ENTRY";
}

export class MysqlBillingRepo implements BillingRepo {
  private readonly now: () => number;
  private readonly entryId: () => string;

  constructor(
    private readonly db: Db,
    options: BillingRepoOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.entryId = options.entryId ?? randomUUID;
  }

  async balance(accountId: string): Promise<WalletBalance> {
    accountOf(accountId);
    const [row] = await this.db
      .select()
      .from(billingWallets)
      .where(eq(billingWallets.accountKey, billingKey(accountId)))
      .limit(1);
    return row ? walletOf(row) : emptyWallet(accountId);
  }

  async ledger(accountId: string, query?: LedgerQuery) {
    const { limit, cursor } = ledgerQuery(accountId, query);
    const rows = await this.db
      .select()
      .from(billingLedger)
      .where(
        and(
          eq(billingLedger.accountKey, billingKey(accountId)),
          cursor
            ? or(
                lt(billingLedger.createdAt, cursor.createdAt),
                and(eq(billingLedger.createdAt, cursor.createdAt), lt(billingLedger.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(billingLedger.createdAt), desc(billingLedger.id))
      .limit(limit + 1);
    return ledgerPage(rows.map(ledgerOf), limit);
  }

  private async inWallet<T>(
    accountId: string,
    fn: (tx: Tx, wallet: WalletBalance) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(
      async (tx) => {
        const accountKey = billingKey(accountId);
        // INSERT/重复键UPDATE均持有账户行排他锁直到事务结束,含首次并发开户。
        await tx
          .insert(billingWallets)
          .values({ accountKey, ...emptyWallet(accountId) })
          .onDuplicateKeyUpdate({ set: { accountKey } });
        const [row] = await tx
          .select()
          .from(billingWallets)
          .where(eq(billingWallets.accountKey, accountKey))
          .limit(1);
        if (!row) throw new BillingError(500, "wallet_missing", "账户初始化失败");
        return fn(tx, walletOf(row));
      },
      { isolationLevel: "read committed" },
    );
  }

  private async append(tx: Tx, next: WalletBalance, entry: LedgerEntry): Promise<void> {
    const accountKey = billingKey(next.accountId);
    await tx
      .update(billingWallets)
      .set({
        availableMicroCredits: next.availableMicroCredits,
        reservedMicroCredits: next.reservedMicroCredits,
      })
      .where(eq(billingWallets.accountKey, accountKey));
    await tx.insert(billingLedger).values({
      ...entry,
      accountKey,
      operationKey: billingKey(entry.accountId, entry.kind, entry.reference),
    });
  }

  async credit(input: CreditRequest) {
    validateCredit(input);
    try {
      return await this.inWallet(input.accountId, async (tx, wallet) => {
        const [prior] = await tx
          .select()
          .from(billingLedger)
          .where(
            eq(
              billingLedger.operationKey,
              billingKey(input.accountId, "credit", input.idempotencyKey),
            ),
          )
          .limit(1);
        if (prior) {
          const entry = ledgerOf(prior);
          assertCreditReplay(entry, input);
          return { balance: wallet, entry, replayed: true };
        }
        const next = creditBalance(wallet, input.amountMicroCredits);
        const entry = entryOf(
          next,
          "credit",
          input.amountMicroCredits,
          input.idempotencyKey,
          this.entryId(),
          this.now(),
          { actorId: input.actorId, reason: input.reason },
        );
        await this.append(tx, next, entry);
        return { balance: next, entry, replayed: false };
      });
    } catch (error) {
      if (duplicate(error)) throw new BillingError(409, "ledger_conflict", "流水标识冲突");
      throw error;
    }
  }

  async reserve(input: ReserveRequest): Promise<Reservation> {
    validateReserve(input);
    const reservationKey = billingKey(input.reservationId);
    try {
      return await this.inWallet(input.accountId, async (tx, wallet) => {
        const [prior] = await tx
          .select()
          .from(billingReservations)
          .where(eq(billingReservations.reservationKey, reservationKey))
          .limit(1);
        if (prior) {
          const reservation = reservationOf(prior);
          assertReserveReplay(reservation, input);
          return reservation;
        }
        const next = reserveBalance(wallet, input.amountMicroCredits);
        const reservation: Reservation = {
          id: input.reservationId,
          accountId: input.accountId,
          amountMicroCredits: input.amountMicroCredits,
          state: "reserved",
        };
        await tx.insert(billingReservations).values({ ...reservation, reservationKey });
        await this.append(
          tx,
          next,
          entryOf(
            next,
            "reserve",
            input.amountMicroCredits,
            input.reservationId,
            this.entryId(),
            this.now(),
          ),
        );
        return reservation;
      });
    } catch (error) {
      if (duplicate(error)) {
        // 不同账户可同时争用同一全局预占ID;唯一键败方事务已回滚,重新确认归属。
        const [prior] = await this.db
          .select()
          .from(billingReservations)
          .where(eq(billingReservations.reservationKey, reservationKey))
          .limit(1);
        if (prior) {
          const reservation = reservationOf(prior);
          assertReserveReplay(reservation, input);
          return reservation;
        }
        throw new BillingError(409, "ledger_conflict", "流水标识冲突");
      }
      throw error;
    }
  }

  async settle(input: SettleRequest): Promise<Reservation> {
    validateSettle(input);
    try {
      return await this.inWallet(input.accountId, async (tx, wallet) => {
        const reservationKey = billingKey(input.reservationId);
        const [prior] = await tx
          .select()
          .from(billingReservations)
          .where(eq(billingReservations.reservationKey, reservationKey))
          .limit(1);
        if (!prior) throw new BillingError(404, "reservation_not_found", "预占不存在");
        const reservation = reservationOf(prior);
        assertSettleReplay(reservation, input);
        if (reservation.state === "settled") return reservation;
        const next = settleBalance(wallet, reservation, input.chargedMicroCredits);
        await tx
          .update(billingReservations)
          .set({
            state: "settled",
            chargedMicroCredits: input.chargedMicroCredits,
          })
          .where(eq(billingReservations.reservationKey, reservationKey));
        await this.append(
          tx,
          next,
          entryOf(
            next,
            "settle",
            input.chargedMicroCredits,
            input.reservationId,
            this.entryId(),
            this.now(),
          ),
        );
        return { ...reservation, state: "settled", chargedMicroCredits: input.chargedMicroCredits };
      });
    } catch (error) {
      if (duplicate(error)) throw new BillingError(409, "ledger_conflict", "流水标识冲突");
      throw error;
    }
  }
}
