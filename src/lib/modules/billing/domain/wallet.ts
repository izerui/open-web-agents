import { createHash } from "node:crypto";
import { unitsOf } from "@/lib/modules/capabilities/domain/catalog";
import {
  BillingError,
  type CreditRequest,
  type LedgerEntry,
  type LedgerQuery,
  type RefundRequest,
  type Reservation,
  type ReserveRequest,
  type SettleRequest,
  type WalletBalance,
} from "../ports";

export const MAX_MICRO_CREDITS = 10n ** 30n - 1n;

export function billingKey(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function textOf(value: unknown, field: string, limit: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) {
    throw new BillingError(400, "invalid_request", `${field} 须为 1~${limit} 字符的非空文本`);
  }
}

export function accountOf(value: unknown): asserts value is string {
  textOf(value, "accountId", 36);
}

export function amountOf(raw: unknown, field: string, positive = false): bigint {
  let amount: bigint;
  try {
    amount = unitsOf(raw, field);
  } catch {
    throw new BillingError(400, "invalid_amount", `${field} 须为最多30位的非负整数字符串`);
  }
  if (positive && amount === 0n)
    throw new BillingError(400, "invalid_amount", `${field} 必须大于零`);
  return amount;
}

export function validateCredit(input: CreditRequest): void {
  accountOf(input.accountId);
  amountOf(input.amountMicroCredits, "amountMicroCredits", true);
  textOf(input.idempotencyKey, "idempotencyKey", 128);
  textOf(input.actorId, "actorId", 36);
  textOf(input.reason, "reason", 512);
}

export function validateRefund(input: RefundRequest): void {
  accountOf(input.accountId);
  textOf(input.refundId, "refundId", 128);
  amountOf(input.amountMicroCredits, "amountMicroCredits", true);
}

export function assertRefundReplay(entry: LedgerEntry, input: RefundRequest): void {
  if (entry.amountMicroCredits !== input.amountMicroCredits) {
    throw new BillingError(409, "idempotency_conflict", "同一退还编号的金额不一致");
  }
}

export function validateReserve(input: ReserveRequest): void {
  accountOf(input.accountId);
  textOf(input.reservationId, "reservationId", 128);
  amountOf(input.amountMicroCredits, "amountMicroCredits", true);
}

export function validateSettle(input: SettleRequest): void {
  accountOf(input.accountId);
  textOf(input.reservationId, "reservationId", 128);
  amountOf(input.chargedMicroCredits, "chargedMicroCredits");
}

export function emptyWallet(accountId: string): WalletBalance {
  return { accountId, availableMicroCredits: "0", reservedMicroCredits: "0" };
}

export function creditBalance(balance: WalletBalance, amount: string): WalletBalance {
  const available = BigInt(balance.availableMicroCredits) + BigInt(amount);
  if (available + BigInt(balance.reservedMicroCredits) > MAX_MICRO_CREDITS) {
    throw new BillingError(409, "balance_overflow", "账户总积分超出30位存储范围");
  }
  return { ...balance, availableMicroCredits: available.toString() };
}

export function reserveBalance(balance: WalletBalance, amount: string): WalletBalance {
  const available = BigInt(balance.availableMicroCredits) - BigInt(amount);
  if (available < 0n) throw new BillingError(402, "insufficient_balance", "可用积分不足");
  return {
    ...balance,
    availableMicroCredits: available.toString(),
    reservedMicroCredits: (BigInt(balance.reservedMicroCredits) + BigInt(amount)).toString(),
  };
}

export function settleBalance(
  balance: WalletBalance,
  reservation: Reservation,
  charged: string,
): WalletBalance {
  if (BigInt(charged) > BigInt(reservation.amountMicroCredits)) {
    throw new BillingError(409, "charge_exceeds_reservation", "结算金额不得超过预占金额");
  }
  const reserved = BigInt(balance.reservedMicroCredits) - BigInt(reservation.amountMicroCredits);
  if (reserved < 0n) throw new BillingError(500, "inconsistent_balance", "账户预占余额异常");
  return {
    ...balance,
    availableMicroCredits: (
      BigInt(balance.availableMicroCredits) +
      BigInt(reservation.amountMicroCredits) -
      BigInt(charged)
    ).toString(),
    reservedMicroCredits: reserved.toString(),
  };
}

export function assertCreditReplay(entry: LedgerEntry, input: CreditRequest): void {
  if (
    entry.amountMicroCredits !== input.amountMicroCredits ||
    entry.actorId !== input.actorId ||
    entry.reason !== input.reason
  ) {
    throw new BillingError(409, "idempotency_conflict", "同一幂等键的入账内容不一致");
  }
}

export function assertReservationOwner(reservation: Reservation, accountId: string): void {
  if (reservation.accountId !== accountId) {
    throw new BillingError(409, "reservation_conflict", "预占标识已被其他账户使用");
  }
}

export function assertReserveReplay(reservation: Reservation, input: ReserveRequest): void {
  assertReservationOwner(reservation, input.accountId);
  if (reservation.amountMicroCredits !== input.amountMicroCredits) {
    throw new BillingError(409, "reservation_conflict", "同一预占标识的金额不一致");
  }
}

export function assertSettleReplay(reservation: Reservation, input: SettleRequest): void {
  assertReservationOwner(reservation, input.accountId);
  if (
    reservation.state === "settled" &&
    reservation.chargedMicroCredits !== input.chargedMicroCredits
  ) {
    throw new BillingError(409, "settlement_conflict", "预占已按另一金额结算");
  }
}

interface LedgerCursor {
  accountId: string;
  createdAt: number;
  id: string;
}

export function ledgerQuery(accountId: string, query: LedgerQuery = {}) {
  accountOf(accountId);
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new BillingError(400, "invalid_request", "limit 须为1~100的整数");
  }
  let cursor: LedgerCursor | undefined;
  if (query.cursor !== undefined) {
    try {
      if (
        typeof query.cursor !== "string" ||
        query.cursor.length > 512 ||
        !/^[A-Za-z0-9_-]+$/.test(query.cursor)
      )
        throw new Error("format");
      const decoded = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString("utf8"),
      ) as LedgerCursor;
      if (
        !decoded ||
        decoded.accountId !== accountId ||
        !Number.isSafeInteger(decoded.createdAt) ||
        decoded.createdAt < 0
      )
        throw new Error("scope");
      textOf(decoded.id, "cursor.id", 36);
      cursor = decoded;
    } catch {
      throw new BillingError(400, "invalid_cursor", "资金流水游标无效或不属于当前账户");
    }
  }
  return { limit, cursor };
}

export function ledgerPage(entries: LedgerEntry[], limit: number) {
  const items = entries.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    ...(entries.length > limit && last
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({
              accountId: last.accountId,
              createdAt: last.createdAt,
              id: last.id,
            }),
          ).toString("base64url"),
        }
      : {}),
  };
}

export function entryOf(
  balance: WalletBalance,
  kind: LedgerEntry["kind"],
  amount: string,
  reference: string,
  id: string,
  createdAt: number,
  meta: { actorId?: string; reason?: string } = {},
): LedgerEntry {
  textOf(id, "entryId", 36);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0)
    throw new BillingError(500, "invalid_clock", "流水时间无效");
  return {
    id,
    accountId: balance.accountId,
    kind,
    amountMicroCredits: amount,
    availableAfter: balance.availableMicroCredits,
    reservedAfter: balance.reservedMicroCredits,
    reference,
    createdAt,
    ...meta,
  };
}
