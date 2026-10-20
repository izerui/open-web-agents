import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import {
  RECON_MAX_DAYS,
  reconciliationReport,
} from "@/lib/modules/billing/application/reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/**
 * 对账报表(只读):?from=YYYY-MM-DD&to=YYYY-MM-DD(含两端,最多 31 天)
 * 按提供者、日期汇总用量、成本估算(元)、预计消耗与实际扣除;缺失数据按类别只计条数。
 */
export async function GET(req: Request) {
  try {
    const { auth, runCharges, pricedModels, providers } = getContainer();
    const principal = await auth.resolveWeb(req);
    auth.assertCanAdministerPlatform(principal);
    const q = new URL(req.url).searchParams;
    const from = q.get("from") ?? "";
    const to = q.get("to") ?? "";
    if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(dayMs(from)) || Number.isNaN(dayMs(to))) {
      return Response.json({ error: "from、to 须为 YYYY-MM-DD" }, { status: 400 });
    }
    const span = (dayMs(to) - dayMs(from)) / 86_400_000 + 1;
    if (span < 1 || span > RECON_MAX_DAYS) {
      return Response.json(
        { error: `区间须为 1~${RECON_MAX_DAYS} 天,且 from 不晚于 to` },
        { status: 400 },
      );
    }
    const [report, list] = await Promise.all([
      reconciliationReport(
        { query: runCharges, pricedModels: (p) => pricedModels.forRun(p) },
        { from, to },
      ),
      providers.list(),
    ]);
    const names = new Map(list.map((p) => [p.id, p.name]));
    return Response.json(
      {
        from,
        to,
        truncated: report.truncated,
        lines: report.lines.map((l) => ({
          ...l,
          providerName: l.providerId ? (names.get(l.providerId) ?? l.providerId) : null,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
