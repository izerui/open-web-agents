import { GET as manageAgents } from "@/app/api/admin/market/agents/route";
import { POST as decide } from "@/app/api/admin/market/requests/[id]/route";
import { GET as queue } from "@/app/api/admin/market/requests/route";
import { GET as getMine, POST as submit } from "@/app/api/agents/[id]/listing-request/route";
import { fixture, publishedAgent } from "@/lib/modules/market/__tests__/fixture";
import { InMemoryListingRequestRepo } from "@/lib/modules/market/adapters/in-memory-listing-request-repo";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Container = Awaited<ReturnType<typeof fixture>> & {
  listingRequests: InMemoryListingRequestRepo;
  users: { get: (id: string) => Promise<{ id: string; email: string } | null> };
};
let container: Container;
vi.mock("@/lib/container", () => ({ getContainer: () => container }));

function request(path: string, user: string, body?: unknown, key?: string) {
  return new Request(`http://test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(user ? { "x-test-user": user } : {}),
      ...(key ? { "X-Api-Key": key } : {}),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const agentCtx = (id = publishedAgent.id) => ({ params: Promise.resolve({ id }) });
const reqCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const actions = () =>
  (container.audit.record as ReturnType<typeof vi.fn>).mock.calls.map(
    (c) => (c[0] as { action: string }).action,
  );

beforeEach(async () => {
  const base = await fixture();
  container = {
    ...base,
    listingRequests: new InMemoryListingRequestRepo(),
    users: {
      get: async (id: string) => ({ id, email: `${id}@example.test` }),
    },
  };
});

describe("所有者端:POST/GET /api/agents/[id]/listing-request", () => {
  it("所有者申请成功 201,随后 GET 读到最新一条;再申请 409 pending_exists", async () => {
    const res = await submit(
      request("/api/agents/market-agent/listing-request", "owner", { note: "财务部在用" }),
      agentCtx(),
    );
    expect(res.status).toBe(201);
    const { request: created } = await res.json();
    expect(created).toMatchObject({
      agentId: publishedAgent.id,
      version: 1,
      requesterId: "owner",
      note: "财务部在用",
      status: "pending",
    });
    const mine = await getMine(
      request("/api/agents/market-agent/listing-request", "owner"),
      agentCtx(),
    );
    expect(mine.status).toBe(200);
    expect((await mine.json()).request.id).toBe(created.id);
    const again = await submit(
      request("/api/agents/market-agent/listing-request", "owner", {}),
      agentCtx(),
    );
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("pending_exists");
    expect(actions()).toEqual(["market.listing_request"]);
  });

  it("没有申请过时 GET 返回 null", async () => {
    const res = await getMine(
      request("/api/agents/market-agent/listing-request", "owner"),
      agentCtx(),
    );
    expect(await res.json()).toEqual({ request: null });
  });

  it("未发布 → 409 not_published", async () => {
    await container.agents.upsert({ ...publishedAgent, id: "draft-only" });
    const res = await submit(
      request("/api/agents/draft-only/listing-request", "owner", {}),
      agentCtx("draft-only"),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_published");
  });

  it("看不到的智能体 404;只读协作者 403;未登录 401", async () => {
    expect(
      (
        await submit(
          request("/api/agents/market-agent/listing-request", "stranger", {}),
          agentCtx(),
        )
      ).status,
    ).toBe(404);
    await container.grants.grant({
      id: "w",
      resourceType: "agent",
      resourceId: publishedAgent.id,
      principalType: "user",
      principalId: "writer",
      permission: "write",
    });
    expect(
      (await submit(request("/api/agents/market-agent/listing-request", "writer", {}), agentCtx()))
        .status,
    ).toBe(403);
    expect(
      (await getMine(request("/api/agents/market-agent/listing-request", "writer"), agentCtx()))
        .status,
    ).toBe(403);
    expect(
      (await submit(request("/api/agents/market-agent/listing-request", "", {}), agentCtx()))
        .status,
    ).toBe(401);
  });
});

describe("管理端:申请队列与审核", () => {
  async function pending() {
    const res = await submit(
      request("/api/agents/market-agent/listing-request", "owner", { note: "想上架" }),
      agentCtx(),
    );
    return (await res.json()).request as { id: string };
  }

  it("普通用户不能看队列也不能处理", async () => {
    const r = await pending();
    expect((await queue(request("/api/admin/market/requests", "owner"))).status).toBe(403);
    expect(
      (
        await decide(
          request(`/api/admin/market/requests/${r.id}`, "owner", {
            action: "approve",
            category: "research",
          }),
          reqCtx(r.id),
        )
      ).status,
    ).toBe(403);
    expect((await manageAgents(request("/api/admin/market/agents", "owner"))).status).toBe(403);
  });

  it("队列带智能体名、申请人邮箱、版本、说明;可按状态筛", async () => {
    const r = await pending();
    const res = await queue(request("/api/admin/market/requests?status=pending", "admin"));
    expect(res.status).toBe(200);
    const { requests } = await res.json();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      id: r.id,
      agentName: "Published researcher",
      requesterEmail: "owner@example.test",
      version: 1,
      note: "想上架",
      status: "pending",
    });
    const approved = await queue(request("/api/admin/market/requests?status=approved", "admin"));
    expect((await approved.json()).requests).toEqual([]);
    expect((await queue(request("/api/admin/market/requests?status=x", "admin"))).status).toBe(400);
  });

  it("通过:智能体上架到指定类别,记审计;再处理 409", async () => {
    const r = await pending();
    const res = await decide(
      request(`/api/admin/market/requests/${r.id}`, "admin", {
        action: "approve",
        category: "operations",
      }),
      reqCtx(r.id),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).request).toMatchObject({
      status: "approved",
      category: "operations",
      decidedBy: "admin",
    });
    expect(await container.agents.get(publishedAgent.id)).toMatchObject({
      marketListed: true,
      marketCategory: "operations",
    });
    const again = await decide(
      request(`/api/admin/market/requests/${r.id}`, "admin", { action: "reject", reason: "x" }),
      reqCtx(r.id),
    );
    expect(again.status).toBe(409);
    expect(actions()).toEqual(["market.listing_request", "market.listing_approve"]);
  });

  it("驳回必须带理由;驳回后所有者看到理由,可以再次申请", async () => {
    const r = await pending();
    const bad = await decide(
      request(`/api/admin/market/requests/${r.id}`, "admin", { action: "reject" }),
      reqCtx(r.id),
    );
    expect(bad.status).toBe(400);
    const res = await decide(
      request(`/api/admin/market/requests/${r.id}`, "admin", {
        action: "reject",
        reason: "说明里没写用途",
      }),
      reqCtx(r.id),
    );
    expect(res.status).toBe(200);
    const mine = await getMine(
      request("/api/agents/market-agent/listing-request", "owner"),
      agentCtx(),
    );
    expect((await mine.json()).request).toMatchObject({
      status: "rejected",
      reason: "说明里没写用途",
    });
    expect((await container.agents.get(publishedAgent.id))?.marketListed).not.toBe(true);
    expect(
      (await submit(request("/api/agents/market-agent/listing-request", "owner", {}), agentCtx()))
        .status,
    ).toBe(201);
    expect(actions()).toEqual([
      "market.listing_request",
      "market.listing_reject",
      "market.listing_request",
    ]);
  });

  it("申请不存在 → 404", async () => {
    const res = await decide(
      request("/api/admin/market/requests/none", "admin", { action: "reject", reason: "x" }),
      reqCtx("none"),
    );
    expect(res.status).toBe(404);
  });

  it("管理列表:已发布智能体附所有者邮箱、是否公开、待审申请", async () => {
    const r = await pending();
    await container.grants.grant({
      id: "pub",
      resourceType: "agent",
      resourceId: publishedAgent.id,
      principalType: "*",
      principalId: "*",
      permission: "read",
    });
    const res = await manageAgents(request("/api/admin/market/agents", "admin"));
    expect(res.status).toBe(200);
    const { items } = await res.json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: publishedAgent.id,
      ownerEmail: "owner@example.test",
      isPublic: true,
      marketListed: false,
      pendingRequestId: r.id,
    });
  });

  it("管理列表另附未发布的智能体(界面列出并禁用上架),不含已发布的", async () => {
    await container.agents.upsert({
      ...publishedAgent,
      id: "draft-only",
      name: "草稿助手",
      publishedVersion: undefined,
    });
    const res = await manageAgents(request("/api/admin/market/agents", "admin"));
    const { unpublished } = await res.json();
    expect(unpublished).toEqual([
      expect.objectContaining({
        id: "draft-only",
        name: "草稿助手",
        ownerEmail: "owner@example.test",
        isPublic: false,
      }),
    ]);
  });

  it("申请队列带「是否公开」和智能体当前类别,审核时不必跳页", async () => {
    await pending();
    await container.grants.grant({
      id: "pub",
      resourceType: "agent",
      resourceId: publishedAgent.id,
      principalType: "*",
      principalId: "*",
      permission: "read",
    });
    const res = await queue(request("/api/admin/market/requests?status=pending", "admin"));
    const { requests } = await res.json();
    expect(requests[0]).toMatchObject({ isPublic: true });
    expect(requests[0]).toHaveProperty("agentCategory");
  });

  it("所有者申请时选的类别存进申请、出现在队列里;无效类别 400", async () => {
    const bad = await submit(
      request("/api/agents/market-agent/listing-request", "owner", { category: "nope" }),
      agentCtx(),
    );
    expect(bad.status).toBe(400);
    const res = await submit(
      request("/api/agents/market-agent/listing-request", "owner", {
        note: "想上架",
        category: "content",
      }),
      agentCtx(),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).request).toMatchObject({ requestedCategory: "content" });
    const { requests } = await (
      await queue(request("/api/admin/market/requests?status=pending", "admin"))
    ).json();
    expect(requests[0]).toMatchObject({ requestedCategory: "content" });
  });
});
