import { describe, expect, it } from "vitest";
import { InMemoryBillingRepo } from "../../adapters/in-memory-billing-repo";
import { type BatchAccount, applyBatch, previewBatch } from "../batch-credit";

const ACCOUNTS: BatchAccount[] = [
  { id: "u1", email: "a@x.com", disabled: false },
  { id: "u2", email: "b@x.com", disabled: false },
  { id: "u3", email: "off@x.com", disabled: true },
];

function deps() {
  const billing = new InMemoryBillingRepo();
  return {
    billing,
    deps: {
      findAccount: async (email: string) => ACCOUNTS.find((a) => a.email === email) ?? null,
      credit: (input: Parameters<InMemoryBillingRepo["credit"]>[0]) => billing.credit(input),
      findCredit: (accountId: string, key: string) => billing.findCredit(accountId, key),
    },
  };
}

const EMAILS = "a@x.com\nB@x.com\noff@x.com\nnobody@x.com\nbad\na@x.com";

describe("批量发放积分", () => {
  it("预览:逐个标出可发放 / 已停用 / 不存在 / 格式不对 / 重复,不入账", async () => {
    const { billing, deps: d } = deps();
    expect((await previewBatch(d, EMAILS)).map((l) => [l.email, l.status])).toEqual([
      ["a@x.com", "ready"],
      ["b@x.com", "ready"],
      ["off@x.com", "disabled"],
      ["nobody@x.com", "not_found"],
      ["bad", "invalid"],
      ["a@x.com", "duplicate"],
    ]);
    expect((await billing.balance("u1")).availableMicroCredits).toBe("0");
  });

  it("发放:只给可发放的账号入账,每人一次;同一批次重试不重复到账", async () => {
    const { billing, deps: d } = deps();
    const input = {
      emails: EMAILS,
      amountMicroCredits: "100000000",
      batchKey: "batch-1",
      actorId: "admin",
      reason: "活动发放",
    };
    const first = await applyBatch(d, input);
    expect(first.map((l) => l.status)).toEqual([
      "credited",
      "credited",
      "disabled",
      "not_found",
      "invalid",
      "duplicate",
    ]);
    for (const id of ["u1", "u2"]) {
      expect((await billing.balance(id)).availableMicroCredits).toBe("100000000");
    }
    expect((await billing.balance("u3")).availableMicroCredits).toBe("0");

    const again = await applyBatch(d, input);
    expect(again.slice(0, 2).map((l) => l.status)).toEqual(["replayed", "replayed"]);
    expect((await billing.balance("u1")).availableMicroCredits).toBe("100000000");
  });

  it("同一批次编号换了金额:对应账号报冲突失败,不改动已入账的", async () => {
    const { billing, deps: d } = deps();
    const base = { emails: "a@x.com", batchKey: "batch-2", actorId: "admin", reason: "r" };
    await applyBatch(d, { ...base, amountMicroCredits: "100000000" });
    const r = await applyBatch(d, { ...base, amountMicroCredits: "200000000" });
    expect(r[0]).toMatchObject({ status: "failed" });
    expect((await billing.balance("u1")).availableMicroCredits).toBe("100000000");
  });
});
