// 模型提供者管理界面验收:
//   新建提供者 → 错误 Key 测试连接(错误信息不含 Key)→ 换 Key 成功
//   → 添加模型:积分预览、加价提醒边界 → 用户价目页不暴露提供者与上游模型标识
// 需要管理员:用 OWA_E2E_DATABASE_URL(库名含 test)把测试账号临时设为管理员,没有就跳过。

import http from "node:http";
import type { AddressInfo } from "node:net";
import { type BrowserContext, expect, test } from "@playwright/test";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";
const DB = process.env.OWA_E2E_DATABASE_URL;
const GOOD_KEY = "sk-pw-good-key-4321";

let gateway: http.Server;
let gatewayUrl = "";
/** 大于 0 时假网关延迟这么久才回:用来在"运行还没结束"时做断言 */
let gatewayDelayMs = 0;

test.beforeAll(async () => {
  // 假的 Anthropic 接口:只认 GOOD_KEY;错误时在信息里回显 Key,检查界面会不会把它显示出来
  gateway = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const key = req.headers["x-api-key"];
      if (key !== GOOD_KEY) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `invalid x-api-key: ${key}` } }));
        return;
      }
      const reply = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      };
      if (gatewayDelayMs > 0) setTimeout(reply, gatewayDelayMs);
      else reply();
    });
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});

test.afterAll(() => {
  gateway?.close();
});

async function asAdmin(ctx: BrowserContext): Promise<() => Promise<void>> {
  const email = `pw-admin-${Date.now()}@example.test`;
  const res = await ctx.request.post(`${BASE}/api/auth`, {
    data: { action: "register", email, password: "e2e-password-123456" },
  });
  expect(res.ok()).toBeTruthy();
  const { user } = (await res.json()) as { user: { id: string; role: string } };
  if (user.role === "admin") return async () => {};
  const { createConnection } = await import("mysql2/promise");
  const db = await createConnection(DB as string);
  await db.execute("UPDATE users SET role = 'admin' WHERE id = ?", [user.id]);
  await db.end();
  return async () => {
    const d = await createConnection(DB as string);
    await d.execute("UPDATE users SET role = 'user' WHERE id = ?", [user.id]);
    await d.end();
  };
}

test.describe("模型提供者管理", () => {
  test.skip(!DB || !/test/i.test(new URL(DB).pathname), "需要专用测试库来设置管理员");

  test("提供者、连接测试、模型价格与用户价目", async ({ page, context }) => {
    const restore = await asAdmin(context);
    const tag = Date.now() % 1_000_000;
    const providerName = `PW厂商-${tag}`;
    const modelName = `PW模型-${tag}`;
    const upstream = `pw-upstream-${tag}`;
    try {
      await page.goto(`${BASE}/admin/providers`);
      await page.getByRole("button", { name: "添加提供者" }).click();
      await page.getByLabel("名称").fill(providerName);
      await page.getByLabel("文本接入地址(Anthropic 协议,可稍后填)").fill(gatewayUrl);
      await page.getByLabel("API Key(可稍后填)").fill("sk-pw-wrong-key-8765");
      await page.getByRole("button", { name: "添加", exact: true }).click();
      await page.waitForURL(/\/admin\/providers\/p-/);

      // 错误 Key:失败原因可见,但 Key 被抹掉
      await page.getByLabel("测试用模型").fill(upstream);
      await page.getByRole("button", { name: "测试连接" }).click();
      const failure = page.getByText(/失败\(HTTP 401\)/);
      await expect(failure).toBeVisible();
      await expect(failure).toContainText("***");
      await expect(failure).not.toContainText("wrong-key");

      await page.getByPlaceholder("输入新 Key 以替换").fill(GOOD_KEY);
      await page.getByRole("button", { name: "替换" }).click();
      await expect(page.getByText(/\*+4321/)).toBeVisible();
      await page.getByRole("button", { name: "测试连接" }).click();
      await expect(page.getByText("连接成功").last()).toBeVisible();

      // 添加模型:成本价 → 积分预览;加价 8% 提醒,10% 不提醒
      await page.getByRole("button", { name: "添加模型" }).first().click();
      await page.getByLabel("显示名称").fill(modelName);
      await page.getByLabel("模型标识").fill(upstream);
      const costs: [string, string][] = [
        ["输入 / 百万 token", "21"],
        ["输出 / 百万 token", "105"],
        ["缓存读取 / 百万 token", "2.1"],
        ["缓存写入 / 百万 token", "26.25"],
      ];
      for (const [label, v] of costs) await page.getByLabel(`${label} 成本单价`).fill(v);
      const warning = page.getByText("加价比例不高于充值赠送比例");
      await page.getByLabel("加价比例(%)").fill("8");
      await expect(warning).toBeVisible();
      await page.getByLabel("加价比例(%)").fill("10");
      await expect(warning).toHaveCount(0);
      const dialog = page.getByRole("dialog");
      for (const credits of ["2,100", "2,310", "10,500", "11,550", "2,887.5"]) {
        await expect(dialog.getByText(credits, { exact: true })).toBeVisible();
      }
      await dialog.getByRole("button", { name: "保存" }).click();
      await expect(page.getByText(upstream, { exact: true }).first()).toBeVisible();

      const adminHtml = await page.content();
      expect(adminHtml).not.toContain(GOOD_KEY);
      expect(adminHtml).not.toContain("sk-pw-wrong-key");

      // 用户价目页:看得到模型与售价,看不到提供者与上游模型标识
      await page.goto(`${BASE}/settings/credentials`);
      await expect(page.getByText(modelName)).toBeVisible();
      const userHtml = await page.content();
      expect(userHtml).not.toContain(providerName);
      expect(userHtml).not.toContain(upstream);
    } finally {
      await restore();
    }
  });

  test("工作台与市场显示智能体所用模型的名称与售价,停用后提示不可用", async ({
    page,
    context,
    browser,
  }) => {
    const restore = await asAdmin(context);
    const tag = Date.now() % 1_000_000;
    const providerName = `PW展示厂商-${tag}`;
    const modelName = `PW展示模型-${tag}`;
    const upstream = `pw-show-upstream-${tag}`;
    const api = context.request;
    try {
      const p = await (
        await api.post(`${BASE}/api/admin/providers`, {
          data: {
            definition: {
              name: providerName,
              enabled: true,
              endpoints: { llm: { protocol: "anthropic", baseUrl: gatewayUrl } },
            },
            apiKey: GOOD_KEY,
          },
        })
      ).json();
      const yuan = (v: string) => String(Math.round(Number(v) * 100_000_000));
      const m = await (
        await api.post(`${BASE}/api/admin/models`, {
          data: {
            expectedVersion: null,
            definition: {
              name: modelName,
              kind: "llm",
              modelId: upstream,
              enabled: true,
              acceptsImages: false,
              providerId: p.provider.id,
              markupBp: 1000,
              costRates: [
                { meter: "input_token", units: "1000000", microCredits: yuan("21") },
                { meter: "output_token", units: "1000000", microCredits: yuan("105") },
                { meter: "cache_read_token", units: "1000000", microCredits: "0" },
                { meter: "cache_write_token", units: "1000000", microCredits: "0" },
              ],
              rates: [],
            },
          },
        })
      ).json();
      const agent = await (
        await api.post(`${BASE}/api/agents`, {
          data: {
            name: `PW展示智能体-${tag}`,
            config: { systemPrompt: "测试", model: m.model.id },
          },
        })
      ).json();
      const agentId = agent.agent.id as string;
      expect(
        (await api.post(`${BASE}/api/agents/${agentId}/versions`, { data: {} })).status(),
      ).toBe(201);
      expect(
        (
          await api.patch(`${BASE}/api/market/${agentId}`, {
            data: { listed: true, category: "research" },
          })
        ).status(),
      ).toBe(200);
      const expected = `${modelName} · 输入 2,310 / 输出 11,550 积分/百万token`;

      // 普通用户:市场详情、市场列表、工作台
      const userCtx = await browser.newContext();
      const user = await userCtx.newPage();
      const reg = await userCtx.request.post(`${BASE}/api/auth`, {
        data: {
          action: "register",
          email: `pw-viewer-${Date.now()}@example.test`,
          password: "e2e-password-123456",
        },
      });
      expect(reg.ok()).toBeTruthy();
      await user.goto(`${BASE}/market/${agentId}`);
      await expect(user.getByTestId("agent-model-price")).toHaveText(expected);
      await user.goto(`${BASE}/market`);
      const card = user.locator("li", { hasText: `PW展示智能体-${tag}` });
      await expect(card.getByTestId("agent-model-price")).toHaveText(expected);
      for (const html of [await user.content()]) {
        expect(html).not.toContain(providerName);
        expect(html).not.toContain(upstream);
      }
      await userCtx.close();

      // 作者在工作台
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(`${BASE}/`);
      // 通过切换器选中;?agent= 深链接在能看到内置默认智能体时不生效(工作台原有问题,另行处理)
      await page.getByTitle("切换智能体").click();
      await page.getByPlaceholder("搜索智能体…").fill(`PW展示智能体-${tag}`);
      await page.getByRole("option", { name: new RegExp(`PW展示智能体-${tag}`) }).click();
      await expect(page.getByTestId("agent-model-price")).toHaveText(expected);
      expect(await page.content()).not.toContain(upstream);

      // 停用后如实提示
      expect(
        (
          await api.post(`${BASE}/api/admin/models`, {
            data: { expectedVersion: m.model.version, definition: { ...m.model, enabled: false } },
          })
        ).status(),
      ).toBe(200);
      // 整页刷新会重新拉取模型目录(页面内缓存随页面重建)
      await page.reload();
      await page.getByTitle("切换智能体").click();
      await page.getByPlaceholder("搜索智能体…").fill(`PW展示智能体-${tag}`);
      await page.getByRole("option", { name: new RegExp(`PW展示智能体-${tag}`) }).click();
      await expect(page.getByTestId("agent-model-price")).toHaveText("模型暂不可用");
    } finally {
      await restore();
    }
  });

  test("工作台按会话实际运行的版本显示模型;调价后不整页刷新也能看到新售价", async ({
    page,
    context,
  }) => {
    const restore = await asAdmin(context);
    const tag = Date.now() % 1_000_000;
    const api = context.request;
    const yuan = (v: string) => String(Math.round(Number(v) * 100_000_000));
    const costs = (input: string) => [
      { meter: "input_token", units: "1000000", microCredits: yuan(input) },
      { meter: "output_token", units: "1000000", microCredits: yuan("100") },
      { meter: "cache_read_token", units: "1000000", microCredits: "0" },
      { meter: "cache_write_token", units: "1000000", microCredits: "0" },
    ];
    try {
      const p = await (
        await api.post(`${BASE}/api/admin/providers`, {
          data: {
            definition: {
              name: `PW版本厂商-${tag}`,
              enabled: true,
              endpoints: { llm: { protocol: "anthropic", baseUrl: gatewayUrl } },
            },
            apiKey: GOOD_KEY,
          },
        })
      ).json();
      const mkModel = async (name: string, input: string) =>
        (
          await (
            await api.post(`${BASE}/api/admin/models`, {
              data: {
                expectedVersion: null,
                definition: {
                  name,
                  kind: "llm",
                  modelId: `pw-${name}`,
                  enabled: true,
                  acceptsImages: false,
                  providerId: p.provider.id,
                  markupBp: 0,
                  costRates: costs(input),
                  rates: [],
                },
              },
            })
          ).json()
        ).model;
      const a = await mkModel(`PW模型A-${tag}`, "10");
      const b = await mkModel(`PW模型B-${tag}`, "20");
      const agentName = `PW版本智能体-${tag}`;
      const agentId = (
        await (
          await api.post(`${BASE}/api/agents`, {
            data: { name: agentName, config: { systemPrompt: "测试", model: a.id } },
          })
        ).json()
      ).agent.id as string;
      expect(
        (await api.post(`${BASE}/api/agents/${agentId}/versions`, { data: {} })).status(),
      ).toBe(201);
      // 草稿改成 B(作者的新会话跟随草稿)
      expect(
        (
          await api.post(`${BASE}/api/agents`, {
            data: { id: agentId, name: agentName, config: { systemPrompt: "测试", model: b.id } },
          })
        ).status(),
      ).toBe(201);
      // 锁定发布版 v1 的会话
      const pinned = (
        await (
          await api.post(`${BASE}/api/sessions`, {
            data: { agentId, versionMode: "published", title: "v1会话" },
          })
        ).json()
      ).session.id as string;
      const textOf = (name: string, input: string) =>
        `${name} · 输入 ${input} / 输出 10,000 积分/百万token`;

      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(`${BASE}/?session=${pinned}`);
      const price = page.getByTestId("agent-model-price");
      await expect(price).toHaveText(textOf(a.name, "1,000"));

      // 新会话(还没创建)按草稿:B
      await page.getByTitle("新建会话").click();
      await expect(price).toHaveText(textOf(b.name, "2,000"));

      // 回到 v1 会话后调价:窗口重新获得焦点时刷新,不整页刷新
      await page.goto(`${BASE}/?session=${pinned}`);
      await expect(price).toHaveText(textOf(a.name, "1,000"));
      const reprice = async (model: { id: string; version: number }, input: string) => {
        const res = await api.post(`${BASE}/api/admin/models`, {
          data: {
            expectedVersion: model.version,
            definition: { ...model, costRates: costs(input), rates: [] },
          },
        });
        expect(res.status()).toBe(200);
        return (await res.json()).model as { id: string; version: number };
      };
      const a2 = await reprice(a, "30");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(price).toHaveText(textOf(a.name, "3,000"));

      // 再调一次价,发起新一轮时刷新
      await reprice(a2, "40");
      await page.getByRole("textbox").last().fill("你好");
      await page.keyboard.press("Enter");
      await expect(price).toHaveText(textOf(a.name, "4,000"));
    } finally {
      await restore();
    }
  });

  test("跟随草稿的会话:另一页把模型改成 B,不刷新继续发送就显示 B;锁定发布版的会话仍是 A", async ({
    page,
    context,
  }) => {
    const restore = await asAdmin(context);
    const tag = Date.now() % 1_000_000;
    const api = context.request;
    const yuan = (v: string) => String(Math.round(Number(v) * 100_000_000));
    try {
      const p = await (
        await api.post(`${BASE}/api/admin/providers`, {
          data: {
            definition: {
              name: `PW草稿厂商-${tag}`,
              enabled: true,
              endpoints: { llm: { protocol: "anthropic", baseUrl: gatewayUrl } },
            },
            apiKey: GOOD_KEY,
          },
        })
      ).json();
      const mkModel = async (name: string, input: string) =>
        (
          await (
            await api.post(`${BASE}/api/admin/models`, {
              data: {
                expectedVersion: null,
                definition: {
                  name,
                  kind: "llm",
                  modelId: `pw-${name}`,
                  enabled: true,
                  acceptsImages: false,
                  providerId: p.provider.id,
                  markupBp: 0,
                  costRates: [
                    { meter: "input_token", units: "1000000", microCredits: yuan(input) },
                    { meter: "output_token", units: "1000000", microCredits: yuan("100") },
                    { meter: "cache_read_token", units: "1000000", microCredits: "0" },
                    { meter: "cache_write_token", units: "1000000", microCredits: "0" },
                  ],
                  rates: [],
                },
              },
            })
          ).json()
        ).model as { id: string; name: string };
      const a = await mkModel(`PW草稿A-${tag}`, "10");
      const b = await mkModel(`PW草稿B-${tag}`, "20");
      const agentName = `PW草稿智能体-${tag}`;
      const saveDraft = (model: string, id?: string) =>
        api.post(`${BASE}/api/agents`, {
          data: { ...(id ? { id } : {}), name: agentName, config: { systemPrompt: "测试", model } },
        });
      const agentId = (await (await saveDraft(a.id)).json()).agent.id as string;
      expect(
        (await api.post(`${BASE}/api/agents/${agentId}/versions`, { data: {} })).status(),
      ).toBe(201);
      const session = async (body: Record<string, unknown>) =>
        (await (await api.post(`${BASE}/api/sessions`, { data: { agentId, ...body } })).json())
          .session.id as string;
      const draftSession = await session({ title: "草稿会话" });
      const pinnedSession = await session({ versionMode: "published", title: "发布会话" });
      const textOf = (m: { name: string }, input: string) =>
        `${m.name} · 输入 ${input} / 输出 10,000 积分/百万token`;

      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(`${BASE}/?session=${draftSession}`);
      const price = page.getByTestId("agent-model-price");
      await expect(price).toHaveText(textOf(a, "1,000"));

      // "另一页"把草稿改成 B;这一页不刷新、不触发焦点,直接发送
      expect((await saveDraft(b.id, agentId)).status()).toBe(201);
      await expect(price).toHaveText(textOf(a, "1,000"));
      // 上游延迟回应:运行还在进行时就要显示 B(运行结束后的列表刷新不算)
      gatewayDelayMs = 8_000;
      try {
        await page.getByRole("textbox").last().fill("你好");
        await page.keyboard.press("Enter");
        const running = page.getByText("运行中", { exact: true });
        await expect(running).toBeVisible();
        await expect(price).toHaveText(textOf(b, "2,000"), { timeout: 3_000 });
        await expect(running).toBeVisible();
      } finally {
        gatewayDelayMs = 0;
      }
      await expect(page.getByText("运行中", { exact: true })).toHaveCount(0, { timeout: 30_000 });

      // 锁定发布版(v1 = A)的会话不受草稿影响;重新获得焦点也仍是 A
      await page.goto(`${BASE}/?session=${pinnedSession}`);
      await expect(price).toHaveText(textOf(a, "1,000"));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForTimeout(500);
      await expect(price).toHaveText(textOf(a, "1,000"));

      // 跟随草稿的会话在焦点回来时也会同步(草稿改回 A)
      await page.goto(`${BASE}/?session=${draftSession}`);
      await expect(price).toHaveText(textOf(b, "2,000"));
      expect((await saveDraft(a.id, agentId)).status()).toBe(201);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(price).toHaveText(textOf(a, "1,000"));
    } finally {
      await restore();
    }
  });
});
