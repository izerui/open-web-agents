import { PATCH as patchMarket } from "@/app/api/market/[id]/route";
import { GET as suggest } from "@/app/api/market/suggest/route";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, publishedAgent } from "./fixture";

let container: Awaited<ReturnType<typeof fixture>>;
vi.mock("@/lib/container", () => ({ getContainer: () => container }));

function request(q: string | null, user = "customer") {
  const url =
    q === null
      ? "http://test/api/market/suggest"
      : `http://test/api/market/suggest?q=${encodeURIComponent(q)}`;
  return new Request(url, { headers: user ? { "x-test-user": user } : {} });
}

type Item = { id: string; name: string; mine: boolean };
async function items(q: string, user = "customer"): Promise<Item[]> {
  const res = await suggest(request(q, user));
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Item[] }).items;
}

beforeEach(async () => {
  container = await fixture();
  await patchMarket(
    new Request("http://test/api/market/market-agent", {
      method: "PATCH",
      headers: { "x-test-user": "admin", "Content-Type": "application/json" },
      body: JSON.stringify({ listed: true, category: "research" }),
    }),
    { params: Promise.resolve({ id: publishedAgent.id }) },
  );
  // 别人的、未上架的智能体:不能出现在推荐里
  await container.agents.upsert({
    id: "private-other",
    ownerId: "someone",
    name: "Researcher private draft",
    description: "not listed",
    config: { model: "sonnet", systemPrompt: "x" },
  });
  // 自己的、未上架的智能体:可以推荐,标明是自己的
  await container.agents.upsert({
    id: "my-agent",
    ownerId: "customer",
    name: "报销审核助手",
    description: "读取发票和报销单，按公司制度做初审",
    config: { model: "sonnet", systemPrompt: "x", starters: ["帮我初审这批发票"] },
  });
});

describe("GET /api/market/suggest", () => {
  it("要求登录;搜索词过长 400;没有搜索词返回空", async () => {
    expect((await suggest(request("x", ""))).status).toBe(401);
    expect((await suggest(request("x".repeat(201)))).status).toBe(400);
    expect(await items("")).toEqual([]);
    expect((await (await suggest(request(null))).json()).items).toEqual([]);
  });

  it("命中上架智能体,不是自己的", async () => {
    const out = await items("published researcher");
    expect(out.map((i) => i.id)).toEqual(["market-agent"]);
    expect(out[0]?.mine).toBe(false);
  });

  it("自己的未上架智能体也能被推荐,标明是自己的;别人的未上架不出现", async () => {
    const out = await items("报销发票初审");
    expect(out.map((i) => i.id)).toEqual(["my-agent"]);
    expect(out[0]).toMatchObject({ mine: true, name: "报销审核助手" });
    expect((await items("private draft")).map((i) => i.id)).not.toContain("private-other");
  });

  it("所有者看到自己上架的智能体时也标为自己的,且不重复", async () => {
    const out = await items("published researcher", "owner");
    expect(out.map((i) => i.id)).toEqual(["market-agent"]);
    expect(out[0]?.mine).toBe(true);
  });

  it("最多 3 条,不暴露提示词与私有配置", async () => {
    for (let i = 0; i < 5; i++) {
      await container.agents.upsert({
        id: `mine-${i}`,
        ownerId: "customer",
        name: `合同比对 ${i}`,
        config: { model: "sonnet", systemPrompt: "private-system-prompt" },
      });
    }
    const res = await suggest(request("合同比对"));
    const body = await res.json();
    expect(body.items).toHaveLength(3);
    expect(JSON.stringify(body)).not.toMatch(/systemPrompt|private-system-prompt|ownerId/);
  });
});
