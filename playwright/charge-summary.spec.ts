// 消耗汇总界面验收:
//   用户积分页按来源 / 智能体 / API Key 汇总,合计正确;点一行只看这部分的运行明细,可回到全部
//   管理员积分管理页有全平台汇总,按账号点进去看该账号
//   旧用量页改名为 token 用量,说明实际扣费以积分页为准,不再显示积分估算
// 需要专用测试库(OWA_E2E_DATABASE_URL,库名含 test):直接写入运行计费记录。

import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, test } from "@playwright/test";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";
const DB = process.env.OWA_E2E_DATABASE_URL;

async function register(ctx: BrowserContext, tag: string) {
  const email = `pw-${tag}-${Date.now()}@example.test`;
  const res = await ctx.request.post(`${BASE}/api/auth`, {
    data: { action: "register", email, password: "e2e-password-123456" },
  });
  expect(res.ok()).toBeTruthy();
  const user = ((await res.json()) as { user: { id: string; role: string } }).user;
  return { ...user, email };
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

const id = () => randomUUID().replace(/-/g, "").slice(0, 24);

/** 给账号写一次已结算的运行:智能体、会话来源、Key 与实扣(积分) */
async function seedRun(
  accountId: string,
  agentId: string,
  source: string,
  apiKeyId: string | null,
  credits: number,
  /** 受理时间的 SQL 表达式;默认现在 */
  at = "NOW(3)",
) {
  const sessionId = id();
  const runId = id();
  await sql(
    "INSERT INTO sessions (id, agent_id, owner_id, billing_user_id, workspace_dir, source) VALUES (?, ?, ?, ?, '/w', ?)",
    [sessionId, agentId, accountId, accountId, source],
  );
  await sql("INSERT INTO runs (id, session_id, status, prompt) VALUES (?, ?, 'success', 'p')", [
    runId,
    sessionId,
  ]);
  const micro = credits * 1_000_000;
  await sql(
    `INSERT INTO run_charges (run_id, account_id, api_key_id, mode, reserved_micro, reservation_ids,
       estimated_micro, charged_micro, owed_micro, state, would_reject, incomplete, settled_cost_digest,
       created_at, settled_at)
     VALUES (?, ?, ?, 'live', 0, '[]', ?, ?, NULL, 'settled', NULL, 0, 'd', ${at}, ${at})`,
    [runId, accountId, apiKeyId, micro, micro],
  );
  return runId;
}

test.describe("消耗汇总", () => {
  test.skip(!DB || !/test/i.test(new URL(DB).pathname), "需要专用测试库");

  test("全平台选上月 → 点账号 → 账号汇总与运行明细仍只看上月", async ({
    page,
    context,
    browser,
  }) => {
    const admin = await register(context, "summary-range-admin");
    const promoted = admin.role !== "admin";
    if (promoted) await sql("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
    const other = await browser.newContext();
    const target = await register(other, "summary-range-target");
    await other.close();
    const agentId = id();
    await sql(
      "INSERT INTO agents (id, owner_id, name, config) VALUES (?, ?, 'PW 上月核对', '{}')",
      [agentId, target.id],
    );
    // 上月中旬一笔 100(离月界 10 天,不受时区影响),本月一笔 7
    const lastMonth = await seedRun(
      target.id,
      agentId,
      "web",
      null,
      100,
      "DATE_SUB(DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01'), INTERVAL 10 DAY)",
    );
    const thisMonth = await seedRun(target.id, agentId, "web", null, 7);
    try {
      await page.goto(`${BASE}/admin/billing`);
      const platform = page.getByRole("region", { name: "全平台消耗汇总" });
      await platform.getByLabel("时间范围").selectOption("last_month");
      await platform.getByRole("button", { name: "按账号" }).click();
      const row = platform.getByTestId("charge-summary-row").filter({ hasText: target.email });
      await expect(row).toContainText("100.00");
      await row.getByRole("button", { name: target.email }).click();
      await expect(page.locator("#billing-account")).toHaveValue(target.id);

      // 账号汇总沿用"上月":只有那 100
      const own = page.getByRole("region", { name: "消耗汇总", exact: true });
      await expect(own.getByLabel("时间范围")).toHaveValue("last_month");
      await expect(own.getByTestId("charge-summary-total")).toContainText("100.00");
      await expect(own.getByTestId("charge-summary-total")).not.toContainText("107.00");
      // 运行明细也只看上月
      await expect(page.getByTestId("run-charge-drill")).toContainText("上月");
      const charges = page.getByTestId("run-charge");
      await expect(charges).toHaveCount(1);
      await expect(charges.first()).toContainText(lastMonth);

      // 对照:看全部时两笔都在;从下拉换账号再换回来,回到默认本月
      await page.getByRole("button", { name: "看全部" }).click();
      await expect(charges).toHaveCount(2);
      await expect(charges.filter({ hasText: thisMonth })).toHaveCount(1);
      await page.locator("#billing-account").selectOption("");
      await page.locator("#billing-account").selectOption(target.id);
      await expect(own.getByLabel("时间范围")).toHaveValue("this_month");
      await expect(own.getByTestId("charge-summary-total")).toContainText("7.00");
      await expect(page.getByTestId("run-charge-drill")).toHaveCount(0);
    } finally {
      if (promoted) await sql("UPDATE users SET role = 'user' WHERE id = ?", [admin.id]);
    }
  });

  test("先点 A → 全平台切上月 → 再点 A:账号区域仍在,汇总与明细切到上月", async ({
    page,
    context,
    browser,
  }) => {
    const admin = await register(context, "summary-same-admin");
    const promoted = admin.role !== "admin";
    if (promoted) await sql("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
    const other = await browser.newContext();
    const target = await register(other, "summary-same-target");
    await other.close();
    const agentId = id();
    await sql("INSERT INTO agents (id, owner_id, name, config) VALUES (?, ?, 'PW 同账号', '{}')", [
      agentId,
      target.id,
    ]);
    const lastMonth = await seedRun(
      target.id,
      agentId,
      "web",
      null,
      100,
      "DATE_SUB(DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01'), INTERVAL 10 DAY)",
    );
    await seedRun(target.id, agentId, "web", null, 7);
    try {
      await page.goto(`${BASE}/admin/billing`);
      const platform = page.getByRole("region", { name: "全平台消耗汇总" });
      await platform.getByRole("button", { name: "按账号" }).click();
      const row = platform.getByTestId("charge-summary-row").filter({ hasText: target.email });
      // 第一次:本月点 A
      await row.getByRole("button", { name: target.email }).click();
      const own = page.getByRole("region", { name: "消耗汇总", exact: true });
      // 账号区域要先载入余额流水再载入汇总,同页还在载入全平台汇总与对账:全量跑时会超过默认的 5 秒
      await expect(own.getByTestId("charge-summary-total")).toContainText("7.00", {
        timeout: 15_000,
      });
      await expect(page.getByTestId("balance-available")).toBeVisible();

      // 全平台切到上月,再点同一个 A
      await platform.getByLabel("时间范围").selectOption("last_month");
      await expect(row).toContainText("100.00");
      await row.getByRole("button", { name: target.email }).click();

      // 账号区域仍在(余额、账号汇总、明细都没消失),并切到上月
      await expect(page.locator("#billing-account")).toHaveValue(target.id);
      await expect(page.getByTestId("balance-available")).toBeVisible();
      await expect(own.getByLabel("时间范围")).toHaveValue("last_month");
      await expect(own.getByTestId("charge-summary-total")).toContainText("100.00", {
        timeout: 15_000,
      });
      await expect(page.getByTestId("run-charge-drill")).toContainText("上月");
      const charges = page.getByTestId("run-charge");
      await expect(charges).toHaveCount(1);
      await expect(charges.first()).toContainText(lastMonth);
      await expect(page.getByRole("heading", { name: "账户流水" })).toBeVisible();
    } finally {
      if (promoted) await sql("UPDATE users SET role = 'user' WHERE id = ?", [admin.id]);
    }
  });

  test("积分页:按来源 / 智能体 / Key 汇总,点一行筛出明细;token 用量页说明以积分页为准", async ({
    page,
    context,
  }) => {
    const user = await register(context, "summary");
    const agentId = id();
    await sql(
      "INSERT INTO agents (id, owner_id, name, config) VALUES (?, ?, 'PW 汇总智能体', '{}')",
      [agentId, user.id],
    );
    const keyId = id();
    await sql(
      "INSERT INTO api_keys (id, owner_id, hashed_key, name) VALUES (?, ?, ?, 'PW 对接 Key')",
      [keyId, user.id, `pw-${keyId}`],
    );
    const web = await seedRun(user.id, agentId, "web", null, 10);
    const invoke = await seedRun(user.id, agentId, "invoke", keyId, 5);

    await page.goto(`${BASE}/settings/billing`);
    const summary = page.getByRole("region", { name: "消耗汇总", exact: true });
    const rows = summary.getByTestId("charge-summary-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "网页对话" })).toContainText("10.00");
    await expect(rows.filter({ hasText: "API 调用" })).toContainText("5.00");
    await expect(summary.getByTestId("charge-summary-total")).toContainText("15.00");
    // 本月合计与"本月已用"一致
    await expect(page.getByText("本月已用 15.00 积分")).toBeVisible();

    await summary.getByRole("button", { name: "按 API Key" }).click();
    await expect(rows.filter({ hasText: "PW 对接 Key" })).toContainText("5.00");
    await expect(rows.filter({ hasText: "不经 API Key" })).toContainText("10.00");

    await summary.getByRole("button", { name: "按智能体" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("PW 汇总智能体");

    // 点一行:运行明细只看这部分
    await summary.getByRole("button", { name: "按来源" }).click();
    await summary.getByRole("button", { name: "API 调用" }).click();
    await expect(page.getByTestId("run-charge-drill")).toContainText("本月 · API 调用");
    const charges = page.getByTestId("run-charge");
    await expect(charges).toHaveCount(1);
    await expect(charges.first()).toContainText(invoke);
    await page.getByRole("button", { name: "看全部" }).click();
    await expect(charges).toHaveCount(2);
    await expect(charges.filter({ hasText: web })).toHaveCount(1);

    await page.goto(`${BASE}/settings/usage`);
    await expect(page.getByRole("heading", { name: "token 用量" })).toBeVisible();
    await expect(page.getByTestId("usage-billing-note")).toContainText("实际扣费以");
    await expect(page.getByText("积分估算")).toHaveCount(0);
  });

  test("管理员积分管理:全平台汇总按账号,点账号看该账号", async ({ page, context, browser }) => {
    const admin = await register(context, "summary-admin");
    const promoted = admin.role !== "admin";
    if (promoted) await sql("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
    const other = await browser.newContext();
    const target = await register(other, "summary-target");
    await other.close();
    const agentId = id();
    await sql(
      "INSERT INTO agents (id, owner_id, name, config) VALUES (?, ?, 'PW 平台汇总', '{}')",
      [agentId, target.id],
    );
    await seedRun(target.id, agentId, "eval", null, 7);
    try {
      await page.goto(`${BASE}/admin/billing`);
      const platform = page.getByRole("region", { name: "全平台消耗汇总" });
      await expect(platform).toBeVisible();
      await expect(platform.getByRole("button", { name: "按 API Key" })).toHaveCount(0);
      await platform.getByRole("button", { name: "按账号" }).click();
      const row = platform.getByTestId("charge-summary-row").filter({ hasText: target.email });
      await expect(row).toContainText("7.00");
      await row.getByRole("button", { name: target.email }).click();
      // 选中该账号:账号下拉切过去,该账号自己的汇总只有评测
      await expect(page.locator("#billing-account")).toHaveValue(target.id);
      const own = page.getByRole("region", { name: "消耗汇总", exact: true });
      await expect(own.getByTestId("charge-summary-row")).toHaveCount(1);
      await expect(own.getByTestId("charge-summary-row").first()).toContainText("评测");
    } finally {
      if (promoted) await sql("UPDATE users SET role = 'user' WHERE id = ?", [admin.id]);
    }
  });
});
