import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/client";
import { creditOrders, creditPackageVersions, creditPackages } from "@/lib/db/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
import {
  cancelledOrder,
  confirmableOrder,
  nextPackage,
  orderPage,
  orderQuery,
  packageIdOf,
  pendingOrder,
  replayOrder,
  validateOrderRequest,
  validatePackageDefinition,
  versionOf,
} from "../domain/package";
import { accountOf, billingKey, textOf } from "../domain/wallet";
import type {
  CreateOrderRequest,
  CreditOrder,
  CreditPackage,
  OrderQuery,
  PackageDefinition,
  PackageRepo,
} from "../package-ports";
import { BillingError } from "../ports";
import { MysqlBillingRepo } from "./mysql-billing-repo";

function packageOf(row: typeof creditPackages.$inferSelect): CreditPackage {
  return {
    ...(row.definition as PackageDefinition),
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

function orderOf(row: typeof creditOrders.$inferSelect): CreditOrder {
  return {
    id: row.id,
    accountId: row.accountId,
    packageId: row.packageId,
    packageVersion: row.packageVersion,
    packageName: row.packageName,
    creditsMicro: row.creditsMicro,
    priceMinor: row.priceMinor,
    currency: row.currency as CreditOrder["currency"],
    status: row.status as CreditOrder["status"],
    createdAt: row.createdAt,
    ...(row.creditedAt !== null ? { creditedAt: row.creditedAt } : {}),
    ...(row.creditedBy !== null ? { creditedBy: row.creditedBy } : {}),
    ...(row.ledgerId !== null ? { ledgerId: row.ledgerId } : {}),
    ...(row.confirmationReason !== null ? { confirmationReason: row.confirmationReason } : {}),
  };
}

function duplicate(error: unknown) {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === "ER_DUP_ENTRY";
}

export class MysqlPackageRepo implements PackageRepo {
  constructor(private readonly db: Db) {}

  async list(includeDisabled = false): Promise<CreditPackage[]> {
    const rows = await this.db
      .select()
      .from(creditPackages)
      .where(includeDisabled ? undefined : eq(creditPackages.enabled, 1))
      .orderBy(creditPackages.id);
    return rows.map(packageOf);
  }

  async get(id: string): Promise<CreditPackage | null> {
    packageIdOf(id);
    const [row] = await this.db
      .select()
      .from(creditPackages)
      .where(eq(creditPackages.id, id))
      .limit(1);
    return row ? packageOf(row) : null;
  }

  async save(
    raw: PackageDefinition,
    expectedVersion: number | null,
    actorId: string,
  ): Promise<CreditPackage> {
    const definition = validatePackageDefinition(raw);
    versionOf(expectedVersion, true);
    textOf(actorId, "actorId", 36);
    try {
      return await this.db.transaction(
        async (tx) => {
          const [row] = await tx
            .select()
            .from(creditPackages)
            .where(eq(creditPackages.id, definition.id))
            .for("update");
          const next = nextPackage(definition, row ? packageOf(row) : null, expectedVersion);
          const values = {
            id: definition.id,
            definition,
            version: next.version,
            enabled: definition.enabled ? 1 : 0,
            updatedAt: next.updatedAt,
          };
          if (row)
            await tx.update(creditPackages).set(values).where(eq(creditPackages.id, definition.id));
          else await tx.insert(creditPackages).values(values);
          await tx.insert(creditPackageVersions).values({
            packageId: definition.id,
            version: next.version,
            definition,
            createdBy: actorId,
            createdAt: next.updatedAt,
          });
          return next;
        },
        { isolationLevel: "read committed" },
      );
    } catch (error) {
      if (duplicate(error))
        throw new BillingError(409, "package_changed", "套餐版本已变化,请刷新后重试");
      throw error;
    }
  }

  async createOrder(input: CreateOrderRequest) {
    validateOrderRequest(input);
    const operationKey = billingKey(input.accountId, input.idempotencyKey);
    try {
      return await this.db.transaction(
        async (tx) => {
          const [existing] = await tx
            .select()
            .from(creditOrders)
            .where(eq(creditOrders.operationKey, operationKey))
            .limit(1);
          if (existing) {
            const order = orderOf(existing);
            replayOrder(order, input);
            return { order, replayed: true };
          }
          const [current] = await tx
            .select()
            .from(creditPackages)
            .where(eq(creditPackages.id, input.packageId))
            .for("update");
          // 等待套餐锁期间,同键请求可能已经创建了订单;须先重放再做状态/价目校验。
          const [raced] = await tx
            .select()
            .from(creditOrders)
            .where(eq(creditOrders.operationKey, operationKey))
            .limit(1);
          if (raced) {
            const order = orderOf(raced);
            replayOrder(order, input);
            return { order, replayed: true };
          }
          const order = pendingOrder(randomUUID(), input, current ? packageOf(current) : null);
          await tx
            .insert(creditOrders)
            .values({ ...order, accountKey: billingKey(input.accountId), operationKey });
          return { order, replayed: false };
        },
        { isolationLevel: "read committed" },
      );
    } catch (error) {
      if (duplicate(error)) {
        const [existing] = await this.db
          .select()
          .from(creditOrders)
          .where(eq(creditOrders.operationKey, operationKey))
          .limit(1);
        if (existing) {
          const order = orderOf(existing);
          replayOrder(order, input);
          return { order, replayed: true };
        }
        throw new BillingError(409, "order_conflict", "订单标识冲突,请重试");
      }
      throw error;
    }
  }

  async getOrder(id: string): Promise<CreditOrder | null> {
    textOf(id, "orderId", 36);
    const [row] = await this.db.select().from(creditOrders).where(eq(creditOrders.id, id)).limit(1);
    return row ? orderOf(row) : null;
  }

  async listOrders(input: OrderQuery = {}) {
    const query = orderQuery(input);
    const c = query.cursor;
    const rows = await this.db
      .select()
      .from(creditOrders)
      .where(
        and(
          query.accountId !== undefined
            ? eq(creditOrders.accountKey, billingKey(query.accountId))
            : undefined,
          c
            ? or(
                lt(creditOrders.createdAt, c.createdAt),
                and(eq(creditOrders.createdAt, c.createdAt), lt(creditOrders.id, c.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(creditOrders.createdAt), desc(creditOrders.id))
      .limit(query.limit + 1);
    return orderPage(rows.map(orderOf), query);
  }

  async cancelOrder(id: string, accountId: string): Promise<CreditOrder> {
    textOf(id, "orderId", 36);
    accountOf(accountId);
    return this.db.transaction(
      async (tx) => {
        const [row] = await tx
          .select()
          .from(creditOrders)
          .where(eq(creditOrders.id, id))
          .for("update");
        const order = cancelledOrder(row ? orderOf(row) : null, accountId);
        if (row?.status !== "cancelled") {
          await tx
            .update(creditOrders)
            .set({ status: "cancelled" })
            .where(eq(creditOrders.id, order.id));
        }
        return order;
      },
      { isolationLevel: "read committed" },
    );
  }

  async confirmOrder(id: string, actorId: string, reason: string) {
    textOf(id, "orderId", 36);
    textOf(actorId, "actorId", 36);
    textOf(reason, "reason", 512);
    return this.db.transaction(
      async (tx) => {
        const [row] = await tx
          .select()
          .from(creditOrders)
          .where(eq(creditOrders.id, id))
          .for("update");
        const order = confirmableOrder(row ? orderOf(row) : null);
        if (order.status === "credited") return { order, replayed: true };
        // 嵌套钱包事务是当前连接上的保存点,外层订单失败会连同资金流水一起回滚。
        const result = await new MysqlBillingRepo(tx as unknown as Db).credit({
          accountId: order.accountId,
          amountMicroCredits: order.creditsMicro,
          idempotencyKey: `package-order:${order.id}`,
          actorId,
          reason,
        });
        const credited: CreditOrder = {
          ...order,
          status: "credited",
          creditedAt: Date.now(),
          creditedBy: actorId,
          ledgerId: result.entry.id,
          confirmationReason: reason,
        };
        await tx
          .update(creditOrders)
          .set({
            status: credited.status,
            creditedAt: credited.creditedAt,
            creditedBy: credited.creditedBy,
            ledgerId: credited.ledgerId,
            confirmationReason: credited.confirmationReason,
          })
          .where(eq(creditOrders.id, order.id));
        return { order: credited, replayed: false };
      },
      { isolationLevel: "read committed" },
    );
  }
}
