import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { BillingError } from "@/lib/modules/billing/ports";
import { parseCredits } from "@/lib/modules/capabilities/domain/catalog";
import { isValidIdempotencyKey } from "@/lib/modules/run/domain/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 管理员人工发放,不是支付回调。重复请求使用同一幂等键,不会重复到账。 */
export async function POST(req: Request) {
  try {
    const { auth, billing, users, audit } = getContainer();
    const principal = await auth.resolveWeb(req);
    auth.assertCanAdministerPlatform(principal);
    const actor = await auth.subjectOf(principal);
    const key = req.headers.get("Idempotency-Key")?.trim();
    if (!key || !isValidIdempotencyKey(key)) {
      return Response.json({ error: "须提供有效的 Idempotency-Key" }, { status: 400 });
    }
    const body = (await req.json().catch(() => null)) as {
      accountId?: unknown;
      credits?: unknown;
      reason?: unknown;
    } | null;
    if (
      !body ||
      typeof body.accountId !== "string" ||
      typeof body.credits !== "string" ||
      typeof body.reason !== "string" ||
      !body.reason.trim() ||
      body.reason.length > 500
    ) {
      return Response.json({ error: "须指定账号、积分文本和 1~500 字入账说明" }, { status: 400 });
    }
    let amountMicroCredits: string;
    try {
      amountMicroCredits = parseCredits(body.credits.trim());
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
    const account = await users.get(body.accountId);
    if (!account) return Response.json({ error: "账号不存在" }, { status: 404 });
    const result = await billing.credit({
      accountId: account.id,
      amountMicroCredits,
      idempotencyKey: key,
      actorId: actor.userId,
      reason: body.reason.trim(),
    });
    await audit.record({
      dedupeKey: `billing.credit:${result.entry.id}`,
      actor: principal,
      action: "billing.credit",
      resource: { type: "wallet", id: account.id },
      ownerId: account.id,
      details: { amountMicroCredits, ledgerId: result.entry.id, via: "manual" },
      req,
    });
    return Response.json(result, {
      status: result.replayed ? 200 : 201,
      headers: { "Cache-Control": "no-store" },
    });
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
