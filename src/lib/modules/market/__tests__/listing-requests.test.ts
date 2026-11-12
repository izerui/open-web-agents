import type { Subject } from "@/lib/modules/access/domain/grants";
import type { Principal } from "@/lib/modules/access/domain/principal";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryListingRequestRepo } from "../adapters/in-memory-listing-request-repo";
import { ListingRequests } from "../application/listing-requests";
import { fixture, publishedAgent } from "./fixture";
import { listingRequestContract } from "./listing-request-contract";

const web = (userId: string, role: "admin" | "user" = "user"): Principal => ({
  type: "web",
  userId,
  role,
});
const subj = (userId: string, role: "admin" | "user" = "user"): Subject => ({ userId, role });
const OWNER = [web("owner"), subj("owner")] as const;
const ADMIN = [web("admin", "admin"), subj("admin", "admin")] as const;

listingRequestContract("上架申请仓储(内存实现)", () => new InMemoryListingRequestRepo(), "mem");

describe("ListingRequests:申请与审核的规则", () => {
  let container: Awaited<ReturnType<typeof fixture>>;
  let service: ListingRequests;
  let clock = 1000;

  beforeEach(async () => {
    container = await fixture();
    clock = 1000;
    let n = 0;
    service = new ListingRequests({
      repo: new InMemoryListingRequestRepo(),
      releases: container.releases,
      market: container.market,
      now: () => ++clock,
      newId: () => `req-${++n}`,
    });
  });

  const agent = async (id = publishedAgent.id) => {
    const a = await container.agents.get(id);
    if (!a) throw new Error("missing agent");
    return a;
  };

  it("所有者申请:取当前发布版,带说明", async () => {
    const r = await service.submit(...OWNER, await agent(), { note: "  财务部在用  " });
    expect(r).toMatchObject({
      id: "req-1",
      agentId: publishedAgent.id,
      version: 1,
      requesterId: "owner",
      note: "财务部在用",
      status: "pending",
    });
    expect(await service.latest(...OWNER, await agent())).toMatchObject({ id: "req-1" });
  });

  it("管理员可以代为申请;别人(含可编辑的协作者)和 API Key 不行", async () => {
    await expect(service.submit(...ADMIN, await agent(), {})).resolves.toMatchObject({
      requesterId: "admin",
    });
    await expect(
      service.submit(web("writer"), subj("writer"), await agent(), {}),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.submit(
        { type: "apiKey", keyId: "k", ownerId: "owner" },
        subj("owner"),
        await agent(),
        {},
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.latest(web("writer"), subj("writer"), await agent()),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it("未发布 → 409 not_published;已有待审 → 409 pending_exists;已上架 → 409 already_listed", async () => {
    await container.agents.upsert({ ...publishedAgent, id: "draft-only" });
    await expect(service.submit(...OWNER, await agent("draft-only"), {})).rejects.toMatchObject({
      status: 409,
      code: "not_published",
    });
    await service.submit(...OWNER, await agent(), {});
    await expect(service.submit(...OWNER, await agent(), {})).rejects.toMatchObject({
      status: 409,
      code: "pending_exists",
    });
    await container.agents.setMarketListing(publishedAgent.id, {
      listed: true,
      category: "general",
    });
    const fresh = new ListingRequests({
      repo: new InMemoryListingRequestRepo(),
      releases: container.releases,
      market: container.market,
    });
    await expect(fresh.submit(...OWNER, await agent(), {})).rejects.toMatchObject({
      status: 409,
      code: "already_listed",
    });
  });

  it("说明必须是不超过 500 字的字符串", async () => {
    await expect(service.submit(...OWNER, await agent(), { note: 3 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.submit(...OWNER, await agent(), { note: "长".repeat(501) }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service.submit(...OWNER, await agent(), null)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("通过:上架到指定类别并记下处理人;再处理一次 → 409 not_pending", async () => {
    const r = await service.submit(...OWNER, await agent(), {});
    const done = await service.decide(ADMIN[0], r.id, { action: "approve", category: "research" });
    expect(done).toMatchObject({
      status: "approved",
      category: "research",
      decidedBy: "admin",
    });
    expect(done.decidedAt).toBeGreaterThan(r.createdAt);
    expect(await container.agents.get(publishedAgent.id)).toMatchObject({
      marketListed: true,
      marketCategory: "research",
    });
    await expect(
      service.decide(ADMIN[0], r.id, { action: "reject", reason: "x" }),
    ).rejects.toMatchObject({ status: 409, code: "not_pending" });
  });

  it("驳回必须写理由;驳回不改上架状态", async () => {
    const r = await service.submit(...OWNER, await agent(), {});
    await expect(service.decide(ADMIN[0], r.id, { action: "reject" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.decide(ADMIN[0], r.id, { action: "reject", reason: "   " }),
    ).rejects.toMatchObject({ status: 400 });
    const done = await service.decide(ADMIN[0], r.id, {
      action: "reject",
      reason: "说明里没写用途",
    });
    expect(done).toMatchObject({ status: "rejected", reason: "说明里没写用途" });
    expect((await container.agents.get(publishedAgent.id))?.marketListed).not.toBe(true);
  });

  it("通过时类别必须有效;动作未知 → 400;申请不存在 → 404", async () => {
    const r = await service.submit(...OWNER, await agent(), {});
    for (const body of [
      { action: "approve" },
      { action: "approve", category: "unknown" },
      { action: "maybe" },
      null,
    ]) {
      await expect(service.decide(ADMIN[0], r.id, body)).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      service.decide(ADMIN[0], "missing", { action: "reject", reason: "x" }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await service.latest(...OWNER, await agent()))?.status).toBe("pending");
  });

  it("只有管理员能看队列和处理", async () => {
    const r = await service.submit(...OWNER, await agent(), {});
    await expect(service.list(web("owner"))).rejects.toMatchObject({ status: 403 });
    await expect(
      service.decide(web("owner"), r.id, { action: "approve", category: "general" }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await service.list(ADMIN[0], "pending")).map((x) => x.id)).toEqual([r.id]);
    expect(await service.list(ADMIN[0], "approved")).toEqual([]);
    await expect(service.list(ADMIN[0], "bogus")).rejects.toMatchObject({ status: 400 });
  });
});
