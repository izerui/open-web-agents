/** 永久积分包与人工确认发放订单;无支付、续费或过期状态。可供客户端 type-only 引用。 */
export interface CreditPackage {
  id: string;
  name: string;
  description?: string;
  creditsMicro: string;
  priceMinor: string;
  currency: "CNY" | "USD";
  enabled: boolean;
  version: number;
  updatedAt: number;
}

export type PackageDefinition = Omit<CreditPackage, "version" | "updatedAt">;

export interface CreditOrder {
  id: string;
  accountId: string;
  packageId: string;
  packageVersion: number;
  packageName: string;
  creditsMicro: string;
  priceMinor: string;
  currency: "CNY" | "USD";
  status: "pending" | "credited" | "cancelled";
  createdAt: number;
  creditedAt?: number;
  creditedBy?: string;
  ledgerId?: string;
  confirmationReason?: string;
}

export interface CreateOrderRequest {
  accountId: string;
  packageId: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface OrderQuery {
  accountId?: string;
  limit?: number;
  cursor?: string;
}

export interface PackageRepo {
  list(includeDisabled?: boolean): Promise<CreditPackage[]>;

  get(id: string): Promise<CreditPackage | null>;

  save(
    definition: PackageDefinition,
    expectedVersion: number | null,
    actorId: string,
  ): Promise<CreditPackage>;

  /** 先重放既有订单,再校验当前套餐状态/版本;金额完全取服务端快照。 */
  createOrder(input: CreateOrderRequest): Promise<{ order: CreditOrder; replayed: boolean }>;

  getOrder(id: string): Promise<CreditOrder | null>;

  listOrders(query?: OrderQuery): Promise<{ items: CreditOrder[]; nextCursor?: string }>;

  cancelOrder(id: string, accountId: string): Promise<CreditOrder>;

  /** 人工确认与钱包入账原子完成;已发放订单重放原确认信息,不重复入账。 */
  confirmOrder(
    id: string,
    actorId: string,
    reason: string,
  ): Promise<{ order: CreditOrder; replayed: boolean }>;
}
