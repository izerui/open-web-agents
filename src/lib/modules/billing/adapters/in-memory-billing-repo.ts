import { randomUUID } from "node:crypto";
import {
  accountOf,
  assertCreditReplay,
  assertRefundReplay,
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
  validateRefund,
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
  type RefundRequest,
  type Reservation,
  type ReserveRequest,
  type SettleRequest,
  type WalletBalance,
} from "../ports";

export class InMemoryBillingRepo implements BillingRepo {
  private wallets = new Map<string, WalletBalance>();
  private entries = new Map<string, LedgerEntry>();
  private operations = new Map<string, LedgerEntry>();
  private reservations = new Map<string, Reservation>();
  private readonly now: () => number;
  private readonly entryId: () => string;

  constructor(options: BillingRepoOptions = {}) {
    this.now = options.now ?? Date.now;
    this.entryId = options.entryId ?? randomUUID;
  }

  async balance(accountId: string): Promise<WalletBalance> {
    accountOf(accountId);
    return { ...(this.wallets.get(accountId) ?? emptyWallet(accountId)) };
  }

  async ledger(accountId: string, query?: LedgerQuery) {
    const { limit, cursor } = ledgerQuery(accountId, query);
    const entries = [...this.entries.values()]
      .filter(
        (e) =>
          e.accountId === accountId &&
          (!cursor ||
            e.createdAt < cursor.createdAt ||
            (e.createdAt === cursor.createdAt && e.id < cursor.id)),
      )
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return structuredClone(ledgerPage(entries, limit));
  }

  /** 所有校验在写入之前完成,提交段无 await,不会出现余额已改但流水未落的中间状态。 */
  private commit(balance: WalletBalance, entry: LedgerEntry): void {
    const key = billingKey(entry.accountId, entry.kind, entry.reference);
    if (this.entries.has(entry.id) || this.operations.has(key)) {
      throw new BillingError(409, "ledger_conflict", "流水标识冲突");
    }
    this.wallets.set(balance.accountId, balance);
    this.entries.set(entry.id, entry);
    this.operations.set(key, entry);
  }

  async findCredit(accountId: string, idempotencyKey: string): Promise<LedgerEntry | null> {
    const e = this.operations.get(billingKey(accountId, "credit", idempotencyKey));
    return e ? structuredClone(e) : null;
  }

  async credit(input: CreditRequest) {
    validateCredit(input);
    const balance = this.wallets.get(input.accountId) ?? emptyWallet(input.accountId);
    const previous = this.operations.get(
      billingKey(input.accountId, "credit", input.idempotencyKey),
    );
    if (previous) {
      assertCreditReplay(previous, input);
      return structuredClone({ balance, entry: previous, replayed: true });
    }
    const next = creditBalance(balance, input.amountMicroCredits);
    const entry = entryOf(
      next,
      "credit",
      input.amountMicroCredits,
      input.idempotencyKey,
      this.entryId(),
      this.now(),
      { actorId: input.actorId, reason: input.reason },
    );
    this.commit(next, entry);
    return structuredClone({ balance: next, entry, replayed: false });
  }

  async refund(input: RefundRequest) {
    validateRefund(input);
    const balance = this.wallets.get(input.accountId) ?? emptyWallet(input.accountId);
    const previous = this.operations.get(billingKey(input.accountId, "refund", input.refundId));
    if (previous) {
      assertRefundReplay(previous, input);
      return structuredClone({ balance, entry: previous, replayed: true });
    }
    const next = creditBalance(balance, input.amountMicroCredits);
    const entry = entryOf(
      next,
      "refund",
      input.amountMicroCredits,
      input.refundId,
      this.entryId(),
      this.now(),
    );
    this.commit(next, entry);
    return structuredClone({ balance: next, entry, replayed: false });
  }

  async reserve(input: ReserveRequest): Promise<Reservation> {
    validateReserve(input);
    const previous = this.reservations.get(input.reservationId);
    if (previous) {
      assertReserveReplay(previous, input);
      return { ...previous };
    }
    const balance = this.wallets.get(input.accountId) ?? emptyWallet(input.accountId);
    const next = reserveBalance(balance, input.amountMicroCredits);
    const reservation: Reservation = {
      id: input.reservationId,
      accountId: input.accountId,
      amountMicroCredits: input.amountMicroCredits,
      state: "reserved",
    };
    this.commit(
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
    this.reservations.set(reservation.id, reservation);
    return { ...reservation };
  }

  async settle(input: SettleRequest): Promise<Reservation> {
    validateSettle(input);
    const reservation = this.reservations.get(input.reservationId);
    if (!reservation) throw new BillingError(404, "reservation_not_found", "预占不存在");
    assertSettleReplay(reservation, input);
    if (reservation.state === "settled") return { ...reservation };
    const balance = this.wallets.get(input.accountId) ?? emptyWallet(input.accountId);
    const next = settleBalance(balance, reservation, input.chargedMicroCredits);
    const settled: Reservation = {
      ...reservation,
      state: "settled",
      chargedMicroCredits: input.chargedMicroCredits,
    };
    this.commit(
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
    this.reservations.set(settled.id, settled);
    return { ...settled };
  }
}
