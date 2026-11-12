import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { BillingError } from "@/lib/modules/billing/ports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { auth, packages, audit } = getContainer();
    const principal = await auth.resolveWeb(req);
    if (principal.type !== "web")
      return Response.json({ error: "集成 Key 无权操作套餐订单" }, { status: 403 });
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as {
      action?: unknown;
      reason?: unknown;
    } | null;
    if (body && Object.keys(body).some((field) => !["action", "reason"].includes(field))) {
      return Response.json({ error: "订单状态和金额不能直接修改" }, { status: 400 });
    }
    if (body?.action === "confirm") {
      auth.assertCanAdministerPlatform(principal);
      if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 200) {
        return Response.json({ error: "请填写 1~200 字的人工确认说明" }, { status: 400 });
      }
      const result = await packages.confirmOrder(id, principal.userId, body.reason.trim());
      if (!result.replayed)
        await audit.record({
          actor: principal,
          action: "billing.order_confirm",
          resource: { type: "order", id },
          ownerId: result.order.accountId,
          details: {
            via: "manual",
            ledgerId: result.order.ledgerId,
            creditsMicro: result.order.creditsMicro,
          },
          req,
        });
      return Response.json({ ...result, paymentMode: "manual" });
    }
    if (body?.action === "admin_cancel") {
      // 管理员取消别人待处理的订单(重复下单、线下没收到款等):必须写原因,审计记到订单所属账号。
      // 仍走仓储的 cancelOrder(按订单所属账号),与人工确认在同一把行锁里互斥 —— 已发放的不能取消
      auth.assertCanAdministerPlatform(principal);
      if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 200) {
        return Response.json({ error: "请填写 1~200 字的取消原因" }, { status: 400 });
      }
      const existing = await packages.getOrder(id);
      if (!existing) return Response.json({ error: "订单不存在" }, { status: 404 });
      const order = await packages.cancelOrder(id, existing.accountId);
      await audit.record({
        actor: principal,
        action: "billing.order_cancel",
        resource: { type: "order", id },
        ownerId: existing.accountId,
        details: { by: "admin", reason: body.reason.trim() },
        req,
      });
      return Response.json({ order });
    }
    if (body?.action === "cancel") {
      const order = await packages.cancelOrder(id, principal.userId);
      await audit.record({
        actor: principal,
        action: "billing.order_cancel",
        resource: { type: "order", id },
        ownerId: principal.userId,
        req,
      });
      return Response.json({ order });
    }
    return Response.json({ error: "未知订单操作" }, { status: 400 });
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
