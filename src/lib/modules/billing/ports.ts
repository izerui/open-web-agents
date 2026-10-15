import { BrandedError } from "@/lib/shared";

export interface WalletBalance {
  accountId: string;
  availableMicroCredits: string;
  reservedMicroCredits: string;
}

export interface LedgerEntry {
  id: string;
  accountId: string;
  kind: "credit" | "reserve" | "settle";
  /** credit=入账额,reserve=冻结额,settle=实际扣除额(0表示全额释放)。 */
  amountMicroCredits: string;
  availableAfter: string;
  reservedAfter: string;
  reference: string;
  actorId?: string;
  reason?: string;
  createdAt: number;
}

export interface Reservation {
  id: string;
  accountId: string;
  amountMicroCredits: string;
  state: "reserved" | "settled";
  chargedMicroCredits?: string;
}

export interface CreditRequest {
  accountId: string;
  amountMicroCredits: string;
  idempotencyKey: string;
  actorId: string;
  reason: string;
}

export interface ReserveRequest {
  accountId: string;
  reservationId: string;
  amountMicroCredits: string;
}

export interface SettleRequest {
  accountId: string;
  reservationId: string;
  chargedMicroCredits: string;
}

export interface LedgerQuery {
  limit?: number;
  cursor?: string;
}

export class BillingError extends BrandedError {
  static readonly brand = Symbol.for("owa.error.BillingError");

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface BillingRepo {
  balance(accountId: string): Promise<WalletBalance>;

  ledger(
    accountId: string,
    query?: LedgerQuery,
  ): Promise<{ items: LedgerEntry[]; nextCursor?: string }>;

  /** 同账户同键同内容重放原流水,返回当前余额;不同内容返回409。 */
  credit(
    input: CreditRequest,
  ): Promise<{ balance: WalletBalance; entry: LedgerEntry; replayed: boolean }>;

  /** 同ID同账户同金额重放当前预占状态;不再次冻结资金。 */
  reserve(input: ReserveRequest): Promise<Reservation>;

  /** 同金额重复结算重放;不同金额拒绝。结算0全额释放。 */
  settle(input: SettleRequest): Promise<Reservation>;
}

/** 确定性测试时可注入时钟/流水ID,业务默认使用系统时钟与随机UUID。 */
export interface BillingRepoOptions {
  now?: () => number;
  entryId?: () => string;
}
