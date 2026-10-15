import type {
  CreateOrderRequest,
  CreditOrder,
  CreditPackage,
  OrderQuery,
  PackageDefinition,
} from "../package-ports";
import { BillingError } from "../ports";
import { accountOf, amountOf, textOf } from "./wallet";

const MAX_VERSION = 2_147_483_647;

export function packageIdOf(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.trim() !== id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new BillingError(
      400,
      "invalid_request",
      "套餐ID须为最多64位小写字母、数字、下划线或连字符",
    );
  }
}

export function versionOf(version: unknown, nullable = false): void {
  if (version === null && nullable) return;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > MAX_VERSION
  ) {
    throw new BillingError(400, "invalid_request", "expectedVersion须为正整数,新建套餐时为null");
  }
}

export function validatePackageDefinition(raw: unknown): PackageDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BillingError(400, "invalid_request", "套餐定义必须为对象");
  }
  const value = raw as Record<string, unknown>;
  const allowed = [
    "id",
    "name",
    "description",
    "creditsMicro",
    "priceMinor",
    "currency",
    "enabled",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new BillingError(400, "invalid_request", "套餐定义包含不支持的字段");
  }
  packageIdOf(value.id);
  textOf(value.name, "name", 120);
  amountOf(value.creditsMicro, "creditsMicro", true);
  amountOf(value.priceMinor, "priceMinor", true);
  if ((value.priceMinor as string).length > 18) {
    throw new BillingError(400, "invalid_amount", "priceMinor须为最多18位正整数字符串");
  }
  if (value.currency !== "CNY" && value.currency !== "USD") {
    throw new BillingError(400, "invalid_request", "currency须为CNY或USD");
  }
  if (typeof value.enabled !== "boolean") {
    throw new BillingError(400, "invalid_request", "enabled须为布尔值");
  }
  if (
    value.description !== undefined &&
    (typeof value.description !== "string" ||
      value.description.length > 1024 ||
      value.description.includes("\0"))
  ) {
    throw new BillingError(400, "invalid_request", "description须为最多1024字符文本");
  }
  return {
    id: value.id,
    name: value.name.trim(),
    ...(typeof value.description === "string" && value.description.trim()
      ? { description: value.description.trim() }
      : {}),
    creditsMicro: value.creditsMicro as string,
    priceMinor: value.priceMinor as string,
    currency: value.currency,
    enabled: value.enabled,
  };
}

export function nextPackage(
  definition: PackageDefinition,
  current: CreditPackage | null,
  expected: number | null,
): CreditPackage {
  if ((current?.version ?? null) !== expected)
    throw new BillingError(409, "package_changed", "套餐版本已变化,请刷新后重试");
  const version = (current?.version ?? 0) + 1;
  if (version > MAX_VERSION)
    throw new BillingError(409, "package_version_limit", "套餐版本已达上限");
  return { ...definition, version, updatedAt: Date.now() };
}

export function validateOrderRequest(input: CreateOrderRequest): void {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["accountId", "packageId", "expectedVersion", "idempotencyKey"].includes(key),
    )
  ) {
    throw new BillingError(400, "invalid_request", "订单只接受账号、套餐、版本与幂等键");
  }
  accountOf(input.accountId);
  packageIdOf(input.packageId);
  versionOf(input.expectedVersion);
  textOf(input.idempotencyKey, "idempotencyKey", 128);
}

export function replayOrder(order: CreditOrder, input: CreateOrderRequest): void {
  if (order.packageId !== input.packageId || order.packageVersion !== input.expectedVersion) {
    throw new BillingError(409, "idempotency_conflict", "同一幂等键的套餐或版本不一致");
  }
}

export function pendingOrder(
  id: string,
  input: CreateOrderRequest,
  current: CreditPackage | null,
): CreditOrder {
  if (!current) throw new BillingError(404, "package_not_found", "套餐不存在");
  if (!current.enabled) throw new BillingError(409, "package_disabled", "套餐已停用");
  if (current.version !== input.expectedVersion)
    throw new BillingError(409, "package_changed", "套餐版本已变化,请重新确认价目");
  return {
    id,
    accountId: input.accountId,
    packageId: current.id,
    packageVersion: current.version,
    packageName: current.name,
    creditsMicro: current.creditsMicro,
    priceMinor: current.priceMinor,
    currency: current.currency,
    status: "pending",
    createdAt: Date.now(),
  };
}

export function cancelledOrder(order: CreditOrder | null, accountId: string): CreditOrder {
  if (!order || order.accountId !== accountId)
    throw new BillingError(404, "order_not_found", "订单不存在");
  if (order.status === "credited")
    throw new BillingError(409, "order_credited", "已发放积分的订单不能取消");
  return { ...order, status: "cancelled" };
}

export function confirmableOrder(order: CreditOrder | null): CreditOrder {
  if (!order) throw new BillingError(404, "order_not_found", "订单不存在");
  if (order.status === "cancelled")
    throw new BillingError(409, "order_cancelled", "已取消的订单不能确认发放");
  return order;
}

interface OrderCursor {
  scope: string | null;
  createdAt: number;
  id: string;
}

export function orderQuery(query: OrderQuery = {}) {
  if (query.accountId !== undefined) accountOf(query.accountId);
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new BillingError(400, "invalid_request", "limit须为1~100的整数");
  }
  let cursor: OrderCursor | undefined;
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
      ) as OrderCursor;
      if (
        !decoded ||
        decoded.scope !== (query.accountId ?? null) ||
        !Number.isSafeInteger(decoded.createdAt) ||
        decoded.createdAt < 0
      )
        throw new Error("scope");
      textOf(decoded.id, "cursor.id", 36);
      cursor = decoded;
    } catch {
      throw new BillingError(400, "invalid_cursor", "订单游标无效或不属于当前账号范围");
    }
  }
  return { accountId: query.accountId, limit, cursor };
}

export function orderPage(rows: CreditOrder[], query: { accountId?: string; limit: number }) {
  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items,
    ...(rows.length > query.limit && last
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({
              scope: query.accountId ?? null,
              createdAt: last.createdAt,
              id: last.id,
            }),
          ).toString("base64url"),
        }
      : {}),
  };
}
