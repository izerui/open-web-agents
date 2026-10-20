// 积分页与 Key 月度上限的界面验收:
//   用户积分页显示「可用 / 冻结中」、计费说明、运行消耗(应扣 vs 实际扣除)
//   接入中心给 Key 设月度积分上限;管理员积分管理页没有计费模式(计费恒为正式)
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

test.describe("积分与计费界面", () => {
  test.skip(!DB || !/test/i.test(new URL(DB).pathname), "需要专用测试库");

  test("积分页:可用 / 冻结中、计费说明、运行消耗明细", async ({ page, context }) => {
    const user = await register(context, "billing");
    const runId = randomUUID();
    // 一次已结算的运行:应扣 57.75 积分、实扣 57.75
    await sql(
      `INSERT INTO run_charges (run_id, account_id, api_key_id, mode, reserved_micro, reservation_ids,
         estimated_micro, charged_micro, owed_micro, state, would_reject, incomplete, created_at, settled_at)
       VALUES (?, ?, NULL, 'live', 300000000, '[]', 57750000, 57750000, NULL, 'settled', NULL, 0, NOW(3), NOW(3))`,
      [runId, user.id],
    );
    try {
      await page.goto(`${BASE}/settings/billing`);
      await expect(page.getByText("可用", { exact: true })).toBeVisible();
      await expect(page.getByText("冻结中", { exact: true })).toBeVisible();
      await expect(page.getByTestId("balance-available")).toHaveText("0.00");
      await expect(page.getByTestId("balance-reserved")).toHaveText("0");
      await expect(page.getByText("结束后按实际用量扣除")).toBeVisible();
      const row = page.getByTestId("run-charge").filter({ hasText: runId });
      await expect(row.locator("td").nth(2)).toHaveText("57.75");
      await expect(row.locator("td").nth(3)).toHaveText("57.75");
      await expect(row).toContainText("已结算");
      // 没有试算的概念
      await expect(page.getByText(/试算|预计消耗|本应拒绝/)).toHaveCount(0);
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

  test("管理员积分管理:没有计费模式与试算", async ({ page, context }) => {
    const user = await register(context, "billing-admin");
    const promoted = user.role !== "admin";
    if (promoted) await sql("UPDATE users SET role = 'admin' WHERE id = ?", [user.id]);
    try {
      await page.goto(`${BASE}/admin/billing`);
      await expect(page.getByRole("region", { name: "对账", exact: true })).toBeVisible();
      await expect(page.getByTestId("billing-mode")).toHaveCount(0);
      await expect(page.getByText(/试算|计费模式|正式扣费/)).toHaveCount(0);
      const api = await context.request.put(`${BASE}/api/admin/billing-mode`, {
        data: { mode: "trial" },
      });
      expect(api.ok()).toBeFalsy();
    } finally {
      if (promoted) await sql("UPDATE users SET role = 'user' WHERE id = ?", [user.id]);
    }
  });

  test("积分页:暂记与多扣退还的说明(欠款、未完整计价不退、用量待补记、已退还)", async ({
    page,
    context,
  }) => {
    const user = await register(context, "provisional");
    const rows = [
      // 实际 57.75,只扣到 30,欠 27.75
      { id: randomUUID(), charged: 30_000_000, est: 57_750_000, owed: 27_750_000 },
      // 已扣 92.4,修正后的费用 69.3 仍不完整:不退,继续暂记
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
      await expect(row(0).locator("td").nth(3)).toHaveText("30.00");
      await expect(row(1)).toContainText("用量待补记,待核对");
      await expect(row(1)).not.toContainText("退还");
      await expect(row(1).locator("td").nth(2)).toHaveText("69.30");
      await expect(row(1).locator("td").nth(3)).toHaveText("92.40");
      await expect(row(2)).toContainText("用量待补记,待核对");
    } finally {
      for (const r of rows) await sql("DELETE FROM run_charges WHERE run_id = ?", [r.id]);
    }
    // 已结算、且自动退还过多扣的:说明退了多少,实际扣除是净额
    const refunded = randomUUID();
    await sql(
      `INSERT INTO run_charges (run_id, account_id, api_key_id, mode, reserved_micro, reservation_ids,
         estimated_micro, charged_micro, owed_micro, refunded_micro, state, would_reject, incomplete,
         created_at, settled_at)
       VALUES (?, ?, NULL, 'live', 0, '[]', 69300000, 69300000, NULL, 23100000, 'settled', NULL, 0, NOW(3), NOW(3))`,
      [refunded, user.id],
    );
    try {
      await page.reload();
      const r = page.getByTestId("run-charge").filter({ hasText: refunded });
      await expect(r).toContainText("已结算(多扣的 23.10 积分已退还)");
      await expect(r.locator("td").nth(3)).toHaveText("69.30");
    } finally {
      await sql("DELETE FROM run_charges WHERE run_id = ?", [refunded]);
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

  test("积分管理:跨账号待核对列表 —— 按原因筛选,点账号看流水,只读不改动", async ({
    page,
    context,
    browser,
  }) => {
    const admin = await register(context, "pending-admin");
    const promoted = admin.role !== "admin";
    if (promoted) await sql("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
    const other = await browser.newContext();
    const target = await register(other, "pending-target");
    await other.close();
    const [u] = (await sql("SELECT email FROM users WHERE id = ?", [target.id])) as unknown as [
      { email: string }[],
    ];
    const email = u[0]?.email ?? "";
    // 欠款、无法完整计价(已扣多于能算出的部分,不算多扣)、用量未知、无法完整计价(还没扣)
    const seed = [
      {
        id: randomUUID(),
        mode: "live",
        est: 57_750_000,
        charged: 30_000_000,
        owed: 27_750_000,
        digest: "d",
      },
      {
        id: randomUUID(),
        mode: "live",
        est: 69_300_000,
        charged: 92_400_000,
        owed: null,
        digest: "d",
      },
      { id: randomUUID(), mode: "live", est: 0, charged: 0, owed: null, digest: null },
      { id: randomUUID(), mode: "live", est: 1_000_000, charged: 0, owed: null, digest: "d" },
    ];
    for (const r of seed) {
      await sql(
        `INSERT INTO run_charges (run_id, account_id, api_key_id, mode, reserved_micro, reservation_ids,
           estimated_micro, charged_micro, owed_micro, state, would_reject, incomplete, settled_cost_digest,
           created_at, settled_at)
         VALUES (?, ?, NULL, ?, 0, '[]', ?, ?, ?, 'provisional', NULL, 1, ?, NOW(3), NOW(3))`,
        [r.id, target.id, r.mode, r.est, r.charged, r.owed, r.digest],
      );
    }
    const snapshot = async () =>
      JSON.stringify(
        (
          (await sql("SELECT * FROM run_charges WHERE account_id = ? ORDER BY run_id", [
            target.id,
          ])) as unknown as [unknown[]]
        )[0],
      );
    const before = await snapshot();
    try {
      await page.goto(`${BASE}/admin/billing`);
      const section = page.getByRole("region", { name: "待核对计费" });
      const row = (i: number) =>
        section.getByTestId("pending-charge").filter({ hasText: seed[i]?.id ?? "" });
      await expect(row(0)).toContainText("欠款");
      await expect(row(0)).toContainText("欠 27.75");
      await expect(row(0)).toContainText(email);
      await expect(row(1)).toContainText("无法完整计价");
      await expect(row(1)).not.toContainText("多扣");
      await expect(row(2)).toContainText("用量未知");
      await expect(row(3)).toContainText("无法完整计价");
      await expect(section.getByLabel("计费模式")).toHaveCount(0);

      // 只读:这一区块没有任何处理按钮
      for (const name of [/核销/, /退还/, /结清/, /确认/]) {
        await expect(section.getByRole("button", { name })).toHaveCount(0);
      }

      // 按原因筛选
      await section.getByRole("button", { name: /^用量未知/ }).click();
      await expect(row(2)).toBeVisible();
      await expect(row(0)).toHaveCount(0);
      await expect(section.getByRole("button", { name: /^多扣/ })).toHaveCount(0);
      await section.getByRole("button", { name: /^全部/ }).click();

      // 点账号:切到这个账号的余额与流水
      await row(0).getByRole("button", { name: email }).click();
      await expect(page.locator("#billing-account")).toHaveValue(target.id);
      await expect(page.getByTestId("balance-available")).toBeVisible();

      expect(await snapshot()).toBe(before);
    } finally {
      for (const r of seed) await sql("DELETE FROM run_charges WHERE run_id = ?", [r.id]);
      if (promoted) await sql("UPDATE users SET role = 'user' WHERE id = ?", [admin.id]);
    }
  });

  test("积分管理:对账 —— 按提供者汇总成本估算,缺失数据单独列出,可导出 CSV", async ({
    page,
    context,
  }) => {
    const admin = await register(context, "recon-admin");
    const promoted = admin.role !== "admin";
    if (promoted) await sql("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
    const tag = Date.now() % 1_000_000;
    const providerName = `对账厂商-${tag}`;
    const runIds: string[] = [];
    try {
      const p = await context.request.post(`${BASE}/api/admin/providers`, {
        data: { definition: { name: providerName, enabled: true, endpoints: {} } },
      });
      expect(p.ok()).toBeTruthy();
      const providerId = ((await p.json()) as { provider: { id: string } }).provider.id;
      const yuan = (v: string) => String(Math.round(Number(v) * 100_000_000));
      const m = await context.request.post(`${BASE}/api/admin/models`, {
        data: {
          expectedVersion: null,
          definition: {
            name: `对账模型-${tag}`,
            kind: "llm",
            modelId: `recon-up-${tag}`,
            enabled: true,
            acceptsImages: false,
            providerId,
            markupBp: 1000,
            costRates: [
              { meter: "input_token", units: "1000000", microCredits: yuan("21") },
              { meter: "output_token", units: "1000000", microCredits: yuan("105") },
              { meter: "cache_read_token", units: "1000000", microCredits: yuan("2.1") },
              { meter: "cache_write_token", units: "1000000", microCredits: yuan("26.25") },
            ],
            rates: [],
          },
        },
      });
      expect(m.ok()).toBeTruthy();
      const model = ((await m.json()) as { model: { id: string; version: number } }).model;
      const pricing = JSON.stringify({
        providerId,
        models: [{ capabilityId: model.id, modelId: `recon-up-${tag}`, version: model.version }],
      });
      const cost = JSON.stringify({
        input: 10000,
        output: 0,
        metering: {
          source: "sdk_model_usage",
          complete: true,
          models: [
            {
              modelId: `recon-up-${tag}`,
              inputTokens: 10000,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        },
      });
      // 完整一条、用量未知一条、没收到用量按 0 结清一条
      for (const [state, withCost] of [
        ["settled", true],
        ["provisional", false],
        ["settled", false],
      ] as const) {
        const id = randomUUID().replace(/-/g, "").slice(0, 24);
        runIds.push(id);
        await sql(
          "INSERT INTO runs (id, session_id, status, prompt, pricing, cost, started_at) VALUES (?, 's', 'failed', 'x', ?, ?, NOW())",
          [id, pricing, withCost ? cost : null],
        );
        await sql(
          `INSERT INTO run_charges (run_id, account_id, api_key_id, mode, reserved_micro, reservation_ids,
             estimated_micro, charged_micro, owed_micro, state, would_reject, incomplete, created_at, settled_at)
           VALUES (?, ?, NULL, 'live', 0, '[]', ?, ?, NULL, ?, NULL, ?, NOW(3), NOW(3))`,
          [
            id,
            admin.id,
            withCost ? 23_100_000 : 0,
            withCost ? 23_100_000 : 0,
            state,
            state === "provisional" ? 1 : 0,
          ],
        );
      }

      await page.goto(`${BASE}/admin/billing`);
      const section = page.getByRole("region", { name: "对账", exact: true });
      const line = section.getByTestId("recon-line").filter({ hasText: providerName });
      await expect(line).toContainText("3");
      await expect(line).toContainText("完整 1");
      await expect(line).toContainText("10,000 / 0");
      await expect(line).toContainText("0.21"); // 成本估算:1 万输入 × 21 元/百万
      await expect(line).toContainText("用量未知 1");
      await expect(line).toContainText("未观察到用量(按 0 结清) 1");

      const download = page.waitForEvent("download");
      await section.getByRole("button", { name: "导出 CSV" }).click();
      const file = await download;
      const fs = await import("node:fs/promises");
      const text = await fs.readFile((await file.path()) ?? "", "utf8");
      expect(text).toContain(providerName);
      expect(text).toContain("成本估算(元)");
    } finally {
      for (const id of runIds) {
        await sql("DELETE FROM run_charges WHERE run_id = ?", [id]);
        await sql("DELETE FROM runs WHERE id = ?", [id]);
      }
      if (promoted) await sql("UPDATE users SET role = 'user' WHERE id = ?", [admin.id]);
    }
  });
});
