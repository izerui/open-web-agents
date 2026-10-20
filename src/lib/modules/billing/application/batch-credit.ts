// 管理员按邮箱批量发放积分。先预览(逐个解析邮箱),确认后对可发放的账号逐个入账。
//
// 确认时在服务端重新解析,不信任预览结果;每个账号的入账沿用单笔发放的幂等:
// 同一批次编号重试不会重复到账(幂等键按账号区分),同编号不同金额报冲突。

import { type ParsedEmail, parseEmailList } from "../domain/batch-credit";
import { assertCreditReplay } from "../domain/wallet";
import { BillingError, type CreditRequest, type LedgerEntry } from "../ports";

export interface BatchAccount {
  id: string;
  email: string;
  disabled: boolean;
}

export interface BatchCreditDeps {
  findAccount(email: string): Promise<BatchAccount | null>;
  credit(input: CreditRequest): Promise<{ entry: LedgerEntry; replayed: boolean }>;
  /** 只读:该账户用这个幂等键入账过的流水 */
  findCredit(accountId: string, idempotencyKey: string): Promise<LedgerEntry | null>;
}

export type BatchLine =
  | { email: string; status: "ready"; accountId: string }
  | { email: string; status: "invalid" | "duplicate" | "not_found" | "disabled" }
  | {
      email: string;
      status: "credited" | "replayed";
      accountId: string;
      ledgerId: string;
      /** 已到账,但这次没能确认审计写成:用原批次重试补(按原流水重放,不重复入账) */
      auditPending?: true;
    }
  /** 这一行没处理成(查账号或写库出错):可用原批次重试,已到账的不会重复 */
  | { email: string; status: "failed"; accountId?: string; error: string };

/** 不把数据库等内部错误原文给到界面 */
const RETRY_HINT = "处理失败,可用原批次重试(已到账的不会重复入账)";

/** 预览:每个邮箱能不能发 */
export async function previewBatch(deps: BatchCreditDeps, emails: string): Promise<BatchLine[]> {
  const lines: BatchLine[] = [];
  // 逐个查:一个邮箱查失败只影响它自己这一行
  for (const p of parseEmailList(emails)) lines.push(await resolveLine(deps, p));
  return lines;
}

async function resolveLine(deps: BatchCreditDeps, p: ParsedEmail): Promise<BatchLine> {
  if (p.status !== "ok") return { email: p.email, status: p.status };
  let account: BatchAccount | null;
  try {
    account = await deps.findAccount(p.email);
  } catch {
    return { email: p.email, status: "failed", error: RETRY_HINT };
  }
  if (!account) return { email: p.email, status: "not_found" };
  if (account.disabled) return { email: p.email, status: "disabled" };
  return { email: p.email, status: "ready", accountId: account.id };
}

/**
 * 发放:对可发放的逐个入账;其余原样带回原因。
 * 单个账号出任何错(账务规则、连接断开……)都只记为这一行失败,继续处理后面的账号。
 */
export async function applyBatch(
  deps: BatchCreditDeps,
  input: {
    emails: string;
    amountMicroCredits: string;
    batchKey: string;
    actorId: string;
    reason: string;
  },
): Promise<BatchLine[]> {
  const idempotencyKey = `batch:${input.batchKey}`;
  const request = (accountId: string): CreditRequest => ({
    accountId,
    amountMicroCredits: input.amountMicroCredits,
    idempotencyKey,
    actorId: input.actorId,
    reason: input.reason,
  });
  const out: BatchLine[] = [];
  for (const p of parseEmailList(input.emails)) {
    if (p.status !== "ok") {
      out.push({ email: p.email, status: p.status });
      continue;
    }
    let accountId: string | undefined;
    try {
      const account = await deps.findAccount(p.email);
      if (!account) {
        out.push({ email: p.email, status: "not_found" });
        continue;
      }
      accountId = account.id;
      // 先认这一批次已有的入账:重放原流水(并让调用方补审计),与账号此刻是否停用无关 ——
      // 停用只阻止【新增】发放,不能让已经到账的那笔从结果里消失、缺了审计
      const prior = await deps.findCredit(account.id, idempotencyKey);
      if (prior) {
        assertCreditReplay(prior, request(account.id));
        out.push({ email: p.email, status: "replayed", accountId, ledgerId: prior.id });
        continue;
      }
      if (account.disabled) {
        out.push({ email: p.email, status: "disabled" });
        continue;
      }
      const r = await deps.credit(request(account.id));
      out.push({
        email: p.email,
        status: r.replayed ? "replayed" : "credited",
        accountId,
        ledgerId: r.entry.id,
      });
    } catch (err) {
      // 单个账号出任何错(账务规则、连接断开……)都只记为这一行失败,继续处理后面的账号
      out.push({
        email: p.email,
        status: "failed",
        ...(accountId ? { accountId } : {}),
        // 账务规则错误(如同批次换了金额)说得清楚;其他内部错误只提示重试
        error: err instanceof BillingError ? err.message : RETRY_HINT,
      });
    }
  }
  return out;
}
