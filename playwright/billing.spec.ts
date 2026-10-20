// 积分页与 Key 月度上限的界面验收:
//   用户积分页显示「可用 / 冻结中」、试算说明、运行消耗(预计 vs 实际、本应拒绝)
//   接入中心给 Key 设月度积分上限;管理员积分管理页显示计费模式与切换确认
// 需要专用测试库(OWA_E2E_DATABASE_URL,库名含 test):写入运行计费记录、临时设管理员。

import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, test } from "@playwright/test";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";
const DB = process.env.OWA_E2E_DATABASE_URL;

async function register(ctx: BrowserContext, tag: string) {
  const res = await ctx.request.post(`${BASE}/api/auth`, {
    data: {
      action: "register",
      email: `pw-${tag}-${Date.now()}@example.test`,
      password: "e2e-password-123456",
    },
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { user: { id: string; role: string } }).user;
}

async function sql(query: string, params: unknown[]) {
  const { createConnection } = await import("mysql2/promise");
  const db = await createConnection(DB as string);
  try {
    return await db.execute(query, params as never[]);
  } finally {
    await db.end();
  }
}

async function billingMode(ctx: BrowserContext): Promise<"trial" | "live"> {
  const res = await ctx.request.get(`${BASE}/api/billing`);
  return ((await res.json()) as { mode: "trial" | "live" }).mode;
}

test.describe("积分与计费界面", () => {
  test.skip(!DB || !/test/i.test(new URL(DB).pathname), "需要专用测试库");

  test("积分页:可用 / 冻结中、试算说明、运行消耗明细", async ({ page, context }) => {
    const user = await register(context, "billing");
    const runId = randomUUID();
    // 一次试算运行:预计 57.75 积分、实扣 0、本应拒绝(余额不足)
    await sql(
      `INSERT INTO run_charges (run_id, account_id, api_key_id, mode, reserved_micro, reservation_ids,
         estimated_micro, charged_micro, owed_micro, state, would_reject, incomplete, created_at, settled_at)
       VALUES (?, ?, NULL, 'trial', 300000000, '[]', 57750000, 0, NULL, 'settled', 'insufficient_balance', 0, NOW(3), NOW(3))`,
      [runId, user.id],
    );
    try {
      await page.goto(`${BASE}/settings/billing`);
      await expect(page.getByText("可用", { exact: true })).toBeVisible();
      await expect(page.getByText("冻结中", { exact: true })).toBeVisible();
      await expect(page.getByTestId("balance-available")).toHaveText("0.00");
      await expect(page.getByTestId("balance-reserved")).toHaveText("0");
      if ((await billingMode(context)) === "trial") {
        await expect(page.getByTestId("trial-banner")).toContainText("不扣积分");
      }
      const row = page.getByTestId("run-charge").filter({ hasText: runId });
      await expect(row).toContainText("试算");
      await expect(row).toContainText("57.75");
      await expect(row).toContainText("本应拒绝:余额不足");
      await expect(row.locator("td").nth(4)).toHaveText("0");
      // 用户界面不出现内部微积分数
      await expect(page.getByText("57750000")).toHaveCount(0);
    } finally {
      await sql("DELETE FROM run_charges WHERE run_id = ?", [runId]);
    }
  });

  test("接入中心:给 Key 设本月积分上限,可取消", async ({ page, context }) => {
    await register(context, "keylimit");
    const issued = await context.request.post(`${BASE}/api/keys`, { data: { name: "pw-limit" } });
    expect(issued.ok()).toBeTruthy();
    await page.goto(`${BASE}/settings/keys`);
    const limit = page.getByRole("button", { name: /不单独限额/ });
    await expect(limit).toBeVisible();
    await limit.click();
    await page.getByLabel("本月积分上限").fill("100");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("button", { name: /\/ 100\.00 积分/ })).toBeVisible();
    await page.getByRole("button", { name: /\/ 100\.00 积分/ }).click();
    await page.getByRole("button", { name: "不限额" }).click();
    await expect(page.getByRole("button", { name: /不单独限额/ })).toBeVisible();
  });

  test("管理员积分管理:显示计费模式,切换前要确认", async ({ page, context }) => {
    const user = await register(context, "billing-admin");
    const promoted = user.role !== "admin";
    if (promoted) await sql("UPDATE users SET role = 'admin' WHERE id = ?", [user.id]);
    try {
      await page.goto(`${BASE}/admin/billing`);
      const mode = page.getByTestId("billing-mode");
      await expect(mode).toHaveText(/试算|正式扣费/);
      const current = (await mode.textContent()) ?? "";
      const next = current.includes("试算") ? "正式扣费" : "试算";
      await page.getByRole("button", { name: `切换为${next}` }).click();
      await expect(page.getByRole("dialog")).toContainText(
        "已受理(排队中、运行中)的运行仍按受理时的模式结算",
      );
      await page.getByRole("button", { name: "取消" }).click();
      await expect(mode).toHaveText(current);
    } finally {
      if (promoted) await sql("UPDATE users SET role = 'user' WHERE id = ?", [user.id]);
    }
  });

  test("积分页:暂记的三种待核对状态(欠款、多扣、用量待补记)显示对应说明", async ({
    page,
    context,
  }) => {
    const user = await register(context, "provisional");
    const rows = [
      // 实际 57.75,只扣到 30,欠 27.75
      { id: randomUUID(), charged: 30_000_000, est: 57_750_000, owed: 27_750_000 },
      // 已扣 92.4,费用修正为 69.3:多扣 23.1
      { id: randomUUID(), charged: 92_400_000, est: 69_300_000, owed: null },
      // 跑过但还没拿到用量
      { id: randomUUID(), charged: 0, est: 0, owed: null },
    ];
    for (const r of rows) {
      await sql(
        `INSERT INTO run_charges (run_id, account_id, api_key_id, mode, reserved_micro, reservation_ids,
           estimated_micro, charged_micro, owed_micro, state, would_reject, incomplete, created_at, settled_at)
         VALUES (?, ?, NULL, 'live', 0, '[]', ?, ?, ?, 'provisional', NULL, 1, NOW(3), NOW(3))`,
        [r.id, user.id, r.est, r.charged, r.owed],
      );
    }
    try {
      await page.goto(`${BASE}/settings/billing`);
      const row = (i: number) =>
        page.getByTestId("run-charge").filter({ hasText: rows[i]?.id ?? "" });
      await expect(row(0)).toContainText("余额不足,欠 27.75 积分,充值后自动补扣");
      await expect(row(0).locator("td").nth(4)).toHaveText("30.00");
      await expect(row(1)).toContainText("多扣 23.10 积分,待核对退还");
      await expect(row(1).locator("td").nth(3)).toHaveText("69.30");
      await expect(row(1).locator("td").nth(4)).toHaveText("92.40");
      await expect(row(2)).toContainText("用量待补记,待核对");
    } finally {
      for (const r of rows) await sql("DELETE FROM run_charges WHERE run_id = ?", [r.id]);
    }
  });

  test("账号管理:旧美元上限显示待处理,按积分设置后提示消失", async ({ page, context, browser }) => {
    const admin = await register(context, "legacy-admin");
    const promoted = admin.role !== "admin";
    if (promoted) await sql("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
    // 另一个上下文注册被管理的账号
    const other = await browser.newContext();
    const target = await register(other, "legacy-target");
    await other.close();
    await sql(
      "UPDATE users SET monthly_quota_micro_usd = 5000000, monthly_limit_micro_credits = NULL WHERE id = ?",
      [target.id],
    );
    try {
      await page.goto(`${BASE}/admin/accounts`);
      const [row] = (await sql("SELECT email FROM users WHERE id = ?", [target.id])) as unknown as [
        { email: string }[],
      ];
      const card = page.locator("div.rounded-xl, [data-slot=card]").filter({
        hasText: row[0]?.email ?? "",
      });
      const legacy = card.getByTestId("legacy-limit");
      await expect(legacy).toContainText("旧上限 $5.00 待按积分重新设置");
      await card.getByLabel("月度上限(积分)").fill("500");
      await card.getByRole("button", { name: "保存上限" }).click();
      await expect(legacy).toHaveCount(0);
      await expect(card).toContainText("上限 500.00");
    } finally {
      if (promoted) await sql("UPDATE users SET role = 'user' WHERE id = ?", [admin.id]);
    }
  });
});
