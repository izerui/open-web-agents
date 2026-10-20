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

  test("积分管理:按邮箱批量发放 —— 预览标出跳过原因,确认后只给可发放的账号入账", async ({
    page,
    context,
    browser,
  }) => {
    const admin = await register(context, "batch-admin");
    const promoted = admin.role !== "admin";
    if (promoted) await sql("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
    const other = await browser.newContext();
    const a = await register(other, "batch-a");
    await other.close();
    const [rows] = (await sql("SELECT email FROM users WHERE id = ?", [a.id])) as unknown as [
      { email: string }[],
    ];
    const email = rows[0]?.email ?? "";
    const missing = `nobody-${Date.now()}@example.test`;
    try {
      await page.goto(`${BASE}/admin/billing`);
      await page.getByLabel(/^邮箱/).fill(`${email}\n${missing}\nnot-an-email`);
      await page.getByLabel("每人积分").fill("8.8");
      await page.getByLabel("发放说明").fill("PW 批量发放");
      await page.getByRole("button", { name: "预览" }).click();
      const table = page.getByTestId("batch-lines");
      await expect(table.locator("tr").filter({ hasText: email })).toContainText("可发放");
      await expect(table.locator("tr").filter({ hasText: missing })).toContainText("没有这个账号");
      await expect(table.locator("tr").filter({ hasText: "not-an-email" })).toContainText(
        "邮箱格式不对",
      );
      await page.getByRole("button", { name: "向 1 个账号发放" }).click();
      await expect(page.getByRole("dialog")).toContainText("向 1 个账号各发放 8.8 积分");
      await page.getByRole("button", { name: "确认发放" }).click();
      await expect(table.locator("tr").filter({ hasText: email })).toContainText("已发放");
      const [w] = (await sql(
        "SELECT available_micro_credits AS v FROM billing_wallets WHERE account_id = ?",
        [a.id],
      )) as unknown as [{ v: string }[]];
      expect(String(w[0]?.v)).toBe("8800000");
    } finally {
      if (promoted) await sql("UPDATE users SET role = 'user' WHERE id = ?", [admin.id]);
    }
  });

  test("批量发放故障注入:到账但审计失败 → 显示审计待补 → 账号被停用、预览也不影响 → 原批次重试补齐,余额不变", async ({
    page,
    context,
    browser,
  }) => {
    const admin = await register(context, "audit-admin");
    const promoted = admin.role !== "admin";
    if (promoted) await sql("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
    const other = await browser.newContext();
    const target = await register(other, "audit-target");
    await other.close();
    const [rows] = (await sql("SELECT email FROM users WHERE id = ?", [target.id])) as unknown as [
      { email: string }[],
    ];
    const email = rows[0]?.email ?? "";
    // 只拦这个账号的审计写入:钱照常到账,审计写失败
    const trigger = `pw_audit_fail_${Date.now()}`;
    const raw = async (q: string) => {
      const { createConnection } = await import("mysql2/promise");
      const db = await createConnection(DB as string);
      try {
        await db.query(q);
      } finally {
        await db.end();
      }
    };
    await raw(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_logs FOR EACH ROW BEGIN IF NEW.owner_id = '${target.id}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit down'; END IF; END`,
    );
    let dropped = false;
    const drop = async () => {
      if (dropped) return;
      dropped = true;
      await raw(`DROP TRIGGER IF EXISTS ${trigger}`);
    };
    try {
      await page.goto(`${BASE}/admin/billing`);
      await page.getByLabel(/^邮箱/).fill(email);
      await page.getByLabel("每人积分").fill("6");
      await page.getByLabel("发放说明").fill("PW 审计故障");
      await page.getByRole("button", { name: "预览" }).click();
      await page.getByRole("button", { name: "向 1 个账号发放" }).click();
      await page.getByRole("button", { name: "确认发放" }).click();

      const table = page.getByTestId("batch-lines");
      const row = table.locator("tr").filter({ hasText: email });
      await expect(row).toContainText("已到账,审计待补");
      const retry = page.getByRole("button", { name: /用原批次重试.*1 个审计待补/ });
      await expect(retry).toBeVisible();

      // 管理员随后停用了这个账号,又点了预览:发放按钮不可用,但重试入口还在
      await sql("UPDATE users SET disabled = 1 WHERE id = ?", [target.id]);
      await page.getByRole("button", { name: "预览" }).click();
      await expect(row).toContainText("账号已停用");
      await expect(retry).toBeVisible();

      await drop();
      await retry.click();
      await expect(row).toContainText("此前已发放");
      await expect(row).not.toContainText("审计待补");
      await expect(page.getByRole("button", { name: /用原批次重试/ })).toHaveCount(0);

      const [w] = (await sql(
        "SELECT available_micro_credits AS v FROM billing_wallets WHERE account_id = ?",
        [target.id],
      )) as unknown as [{ v: string }[]];
      expect(String(w[0]?.v)).toBe("6000000");
      const [a] = (await sql(
        "SELECT COUNT(*) AS n FROM audit_logs WHERE owner_id = ? AND action = 'billing.credit'",
        [target.id],
      )) as unknown as [{ n: number }[]];
      expect(Number(a[0]?.n)).toBe(1);
    } finally {
      await drop();
      if (promoted) await sql("UPDATE users SET role = 'user' WHERE id = ?", [admin.id]);
    }
  });
});
