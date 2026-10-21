// 发布门槛的测试辅助:草稿须有一次配置相同、用例相同、全部通过的评测才能发布。
// 用一个"期望失败"的用例:这里的假网关只回空对象,运行必然失败,这个用例稳定通过。
import { type APIRequestContext, expect } from "@playwright/test";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";

export async function passDraftEval(api: APIRequestContext, agentId: string): Promise<void> {
  const base = `${BASE}/api/agents/${agentId}/evals`;
  const body = { name: "PW 发布门槛", input: "门槛", assertions: { expectSuccess: false } };
  const list = (await (await api.get(`${base}/cases`)).json()) as {
    cases: { id: string; name: string }[];
  };
  const existing = list.cases.find((c) => c.name === body.name);
  if (!existing) expect((await api.post(`${base}/cases`, { data: body })).status()).toBe(201);
  const start = await api.post(`${base}/runs`, { data: { target: "draft" } });
  expect(start.status()).toBe(202);
  const id = ((await start.json()) as { run: { id: string } }).run.id;
  await expect
    .poll(
      async () => {
        const r = (await (await api.get(`${base}/runs/${id}`)).json()) as {
          run: { status: string; passed: number; total: number };
        };
        return r.run.status === "done" ? `${r.run.passed}/${r.run.total}` : "running";
      },
      { timeout: 30_000 },
    )
    .toBe("1/1");
}
