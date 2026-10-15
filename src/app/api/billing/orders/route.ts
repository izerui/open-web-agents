import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { BillingError } from "@/lib/modules/billing/ports";
import { isValidIdempotencyKey } from "@/lib/modules/run/domain/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { auth, packages, users } = getContainer();
    const principal = await auth.resolveWeb(req);
    if (principal.type !== "web")
      return Response.json({ error: "集成 Key 无权读取套餐订单" }, { status: 403 });
    const query = new URL(req.url).searchParams;
    const manage = query.get("manage") === "1";
    if (manage) auth.assertCanAdministerPlatform(principal);
    const result = await packages.listOrders({
      accountId: manage ? undefined : principal.userId,
      limit: 50,
      cursor: query.get("cursor") ?? undefined,
    });
    const owners = new Map(
      await Promise.all(
        [...new Set(result.items.map((order) => order.accountId))].map(
          async (id) => [id, (await users.get(id))?.email] as const,
        ),
      ),
    );
    return Response.json(
      {
        ...result,
        items: result.items.map((order) => ({
          ...order,
          accountEmail: owners.get(order.accountId),
        })),
        paymentMode: "manual",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    if (err instanceof BillingError)
      return Response.json(
        {
          error: err.message,
          code: err.code,
        },
        { status: err.status },
      );
    throw err;
  }
}

export async function POST(req: Request) {
  try {
    const { auth, packages, audit, users } = getContainer();
    const principal = await auth.resolveWeb(req);
    if (principal.type !== "web")
      return Response.json({ error: "请使用账号登录后创建订单" }, { status: 403 });
    const account = await users.get(principal.userId);
    if (!account) return Response.json({ error: "套餐订单需要已注册账号登录" }, { status: 403 });
    const key = req.headers.get("Idempotency-Key")?.trim();
    const body = (await req.json().catch(() => null)) as {
      packageId?: unknown;
      expectedVersion?: unknown;
    } | null;
    if (
      body &&
      Object.keys(body).some((field) => !["packageId", "expectedVersion"].includes(field))
    ) {
      return Response.json({ error: "订单账号、金额和状态由平台确定" }, { status: 400 });
    }
    if (
      !key ||
      !isValidIdempotencyKey(key) ||
      typeof body?.packageId !== "string" ||
      typeof body.expectedVersion !== "number" ||
      !Number.isSafeInteger(body.expectedVersion) ||
      body.expectedVersion < 1
    ) {
      return Response.json({ error: "须提供套餐、版本与有效的 Idempotency-Key" }, { status: 400 });
    }
    const result = await packages.createOrder({
      accountId: account.id,
      packageId: body.packageId,
      expectedVersion: body.expectedVersion,
      idempotencyKey: key,
    });
    if (!result.replayed)
      await audit.record({
        actor: principal,
        action: "billing.order_create",
        resource: { type: "order", id: result.order.id },
        ownerId: principal.userId,
        details: { packageId: result.order.packageId, packageVersion: result.order.packageVersion },
        req,
      });
    return Response.json(
      { ...result, paymentMode: "manual" },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    if (err instanceof BillingError)
      return Response.json(
        {
          error: err.message,
          code: err.code,
        },
        { status: err.status },
      );
    throw err;
  }
}
