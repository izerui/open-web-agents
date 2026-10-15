import { randomUUID } from "node:crypto";
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
import type { BillingRepo } from "../ports";
import { InMemoryBillingRepo } from "./in-memory-billing-repo";

export class InMemoryPackageRepo implements PackageRepo {
  private packages = new Map<string, CreditPackage>();
  private versions = new Map<string, CreditPackage & { createdBy: string }>();
  private orders = new Map<string, CreditOrder>();
  private operations = new Map<string, string>();
  private locks = new Map<string, Promise<void>>();

  constructor(private readonly billing: BillingRepo = new InMemoryBillingRepo()) {}

  async list(includeDisabled = false): Promise<CreditPackage[]> {
    return structuredClone(
      [...this.packages.values()]
        .filter((p) => includeDisabled || p.enabled)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
  }

  async get(id: string): Promise<CreditPackage | null> {
    packageIdOf(id);
    return structuredClone(this.packages.get(id) ?? null);
  }

  async save(
    raw: PackageDefinition,
    expectedVersion: number | null,
    actorId: string,
  ): Promise<CreditPackage> {
    const definition = validatePackageDefinition(raw);
    versionOf(expectedVersion, true);
    textOf(actorId, "actorId", 36);
    const next = nextPackage(definition, this.packages.get(definition.id) ?? null, expectedVersion);
    this.packages.set(next.id, next);
    this.versions.set(
      `${next.id}:${next.version}`,
      structuredClone({ ...next, createdBy: actorId }),
    );
    return structuredClone(next);
  }

  async createOrder(input: CreateOrderRequest) {
    validateOrderRequest(input);
    const key = billingKey(input.accountId, input.idempotencyKey);
    const existingId = this.operations.get(key);
    const existing = existingId ? this.orders.get(existingId) : undefined;
    if (existing) {
      replayOrder(existing, input);
      return { order: structuredClone(existing), replayed: true };
    }
    const order = pendingOrder(randomUUID(), input, this.packages.get(input.packageId) ?? null);
    this.orders.set(order.id, order);
    this.operations.set(key, order.id);
    return { order: structuredClone(order), replayed: false };
  }

  async getOrder(id: string): Promise<CreditOrder | null> {
    textOf(id, "orderId", 36);
    return structuredClone(this.orders.get(id) ?? null);
  }

  async listOrders(input: OrderQuery = {}) {
    const query = orderQuery(input);
    const c = query.cursor;
    const rows = [...this.orders.values()]
      .filter(
        (o) =>
          (query.accountId === undefined || o.accountId === query.accountId) &&
          (!c || o.createdAt < c.createdAt || (o.createdAt === c.createdAt && o.id < c.id)),
      )
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return structuredClone(orderPage(rows, query));
  }

  private async inOrder<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.locks.set(id, tail);
    try {
      return await result;
    } finally {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  async cancelOrder(id: string, accountId: string): Promise<CreditOrder> {
    textOf(id, "orderId", 36);
    accountOf(accountId);
    return this.inOrder(id, async () => {
      const cancelled = cancelledOrder(this.orders.get(id) ?? null, accountId);
      this.orders.set(id, cancelled);
      return structuredClone(cancelled);
    });
  }

  async confirmOrder(id: string, actorId: string, reason: string) {
    textOf(id, "orderId", 36);
    textOf(actorId, "actorId", 36);
    textOf(reason, "reason", 512);
    return this.inOrder(id, async () => {
      const order = confirmableOrder(this.orders.get(id) ?? null);
      if (order.status === "credited") return { order: structuredClone(order), replayed: true };
      const result = await this.billing.credit({
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
      this.orders.set(id, credited);
      return { order: structuredClone(credited), replayed: false };
    });
  }
}
