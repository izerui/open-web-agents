import { apiError } from "@/lib/api-error";
import { monthStartUtc } from "@/lib/modules/billing/application/run-charging";
import { BILLING_MODES, type BillingMode } from "@/lib/modules/billing/domain/run-charge";
import { asModelAdmin, jsonBody } from "../_lib/model-admin-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 当前计费模式与本月试算统计(预计消耗、本应拒绝次数)。 */
export async function GET(req: Request) {
  return asModelAdmin(req, async ({ c }) => {
    const [mode, trial] = await Promise.all([
      c.billingMode.get(),
      c.runCharges.trialStats(monthStartUtc(Date.now())),
    ]);
    return Response.json({ mode, trial }, { headers: { "Cache-Control": "no-store" } });
  });
}

/**
 * 切换计费模式。只影响之后受理的运行:已受理(含排队中、运行中)的按受理时锁定的模式结算。
 */
export async function PUT(req: Request) {
  return asModelAdmin(req, async ({ c, principal, actorId }) => {
    const body = await jsonBody(req);
    if (!(BILLING_MODES as readonly unknown[]).includes(body.mode)) {
      return apiError(400, "invalid_request", 'mode 须为 "trial"(试算)或 "live"(正式扣费)');
    }
    const to = body.mode as BillingMode;
    const from = await c.billingMode.get();
    if (from !== to) {
      await c.billingMode.set(to);
      await c.audit.record({
        actor: principal,
        action: "billing.mode_update",
        resource: { type: "platform", id: "billing_mode" },
        ownerId: actorId,
        details: { from, to },
        req,
      });
    }
    return Response.json({ mode: to });
  });
}
