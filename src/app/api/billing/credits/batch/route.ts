import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import {
  type BatchCreditDeps,
  type BatchLine,
  applyBatch,
  previewBatch,
} from "@/lib/modules/billing/application/batch-credit";
import { parseEmailList } from "@/lib/modules/billing/domain/batch-credit";
import { BillingError } from "@/lib/modules/billing/ports";
import { parseCredits } from "@/lib/modules/capabilities/domain/catalog";
import { isValidIdempotencyKey } from "@/lib/modules/run/domain/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 管理员按邮箱批量发放积分(不是支付回调)。
 * body { emails: 粘贴的邮箱清单, credits?, reason?, preview?: true }
 * - preview:只解析,返回每个邮箱能不能发;
 * - 发放:须带 Idempotency-Key(批次编号)。同一编号重试不会重复到账。
 */
export async function POST(req: Request) {
  try {
    const { auth, billing, users, audit } = getContainer();
    const principal = await auth.resolveWeb(req);
    auth.assertCanAdministerPlatform(principal);
    const actor = await auth.subjectOf(principal);
    const body = (await req.json().catch(() => null)) as {
      emails?: unknown;
      credits?: unknown;
      reason?: unknown;
      preview?: unknown;
    } | null;
    if (!body || typeof body.emails !== "string") {
      return Response.json({ error: "须提供邮箱清单 emails" }, { status: 400 });
    }
    const deps: BatchCreditDeps = {
      findAccount: async (email) => {
        const u = await users.findByEmail(email);
        return u ? { id: u.id, email: u.email, disabled: u.disabled } : null;
      },
      credit: (input) => billing.credit(input),
      findCredit: (accountId, key) => billing.findCredit(accountId, key),
    };

    // 清单本身不合格(空、超过上限)在入账前就 400;之后的意外错误按 500,不冒充成请求错误
    try {
      parseEmailList(body.emails);
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
    if (body.preview === true) {
      const lines = await previewBatch(deps, body.emails);
      return Response.json({ lines }, { headers: { "Cache-Control": "no-store" } });
    }

    // 编号会拼成每个账号的入账幂等键(batch:<编号>),留出前缀的长度
    const key = req.headers.get("Idempotency-Key")?.trim();
    if (!key || !isValidIdempotencyKey(key) || key.length > 100) {
      return Response.json(
        { error: "须提供有效的 Idempotency-Key(不超过 100 字符)" },
        { status: 400 },
      );
    }
    if (
      typeof body.credits !== "string" ||
      typeof body.reason !== "string" ||
      !body.reason.trim() ||
      body.reason.length > 500
    ) {
      return Response.json({ error: "须指定积分文本和 1~500 字发放说明" }, { status: 400 });
    }
    let amountMicroCredits: string;
    try {
      amountMicroCredits = parseCredits(body.credits.trim());
      if (BigInt(amountMicroCredits) <= 0n) throw new Error("发放积分必须大于零");
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
    // 单个账号出错只记为该行失败,不会中断整个批次(见 applyBatch)
    const lines = await applyBatch(deps, {
      emails: body.emails,
      amountMicroCredits,
      batchKey: key,
      actorId: actor.userId,
      reason: body.reason.trim(),
    });
    // 每笔入账记一条审计,记在该账号名下(当事人也看得到)。按入账流水去重:
    // 重试时"此前已发放"的也记 —— 上次审计没写成(请求中途出错)就在这次补上,已有的不重复
    // 审计没写成的行标出来:钱已到账,但要用原批次重试补审计(重试按原流水重放,不会重复入账)
    const result: BatchLine[] = [];
    for (const line of lines) {
      if (line.status !== "credited" && line.status !== "replayed") {
        result.push(line);
        continue;
      }
      const audited = await audit.record({
        dedupeKey: `billing.credit:${line.ledgerId}`,
        actor: principal,
        action: "billing.credit",
        resource: { type: "wallet", id: line.accountId },
        ownerId: line.accountId,
        details: { amountMicroCredits, ledgerId: line.ledgerId, via: "batch", batchKey: key },
        req,
      });
      result.push(audited ? line : { ...line, auditPending: true });
    }
    return Response.json(
      {
        lines: result,
        credited: result.filter((l) => l.status === "credited").length,
        replayed: result.filter((l) => l.status === "replayed").length,
        skipped: result.filter((l) => !["credited", "replayed", "failed"].includes(l.status))
          .length,
        failed: result.filter((l) => l.status === "failed").length,
        auditPending: result.filter((l) => "auditPending" in l && l.auditPending === true).length,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const response = authErrorResponse(err);
    if (response) return response;
    if (err instanceof BillingError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.status });
    }
    throw err;
  }
}
