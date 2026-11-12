import type { Grant } from "@/lib/modules/access/domain/grants";
import type { Group, GroupMember, GroupRepo, NewGroup } from "@/lib/modules/access/group-ports";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 内存版组仓储:只为路由测试,语义照 MysqlGroupRepo */
class FakeGroups implements GroupRepo {
  groups = new Map<string, Group>();
  members_ = new Map<string, GroupMember[]>();
  async create(g: NewGroup) {
    const row = { ...g, createdAt: 1 };
    this.groups.set(g.id, row);
    return row;
  }
  async get(id: string) {
    return this.groups.get(id) ?? null;
  }
  async list(ownerId?: string) {
    return [...this.groups.values()].filter((g) => !ownerId || g.ownerId === ownerId);
  }
  async delete(id: string) {
    this.members_.delete(id);
    this.groups.delete(id);
  }
  async groupIdsOf() {
    return [];
  }
  async members(id: string) {
    return this.members_.get(id) ?? [];
  }
  async addMember(id: string, userId: string) {
    this.members_.set(id, [
      ...(await this.members(id)),
      { userId, email: `${userId}@x`, joinedAt: 1 },
    ]);
  }
  async removeMember(id: string, userId: string) {
    this.members_.set(
      id,
      (await this.members(id)).filter((m) => m.userId !== userId),
    );
  }
}

const state = vi.hoisted(() => ({ user: "admin", role: "admin" as "admin" | "user" }));
let groups: FakeGroups;
let grants: Grant[];
const audit = { record: vi.fn(async (_e: unknown) => true) };

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    groups,
    audit,
    users: { get: async (id: string) => ({ id, email: `${id}@example.test` }) },
    grants: {
      listForType: async () => [...grants],
      revoke: async (id: string) => {
        grants = grants.filter((g) => g.id !== id);
      },
    },
    auth: {
      resolveWeb: async () => ({ type: "web", userId: state.user, role: state.role }),
      assertCanManageAgents: () => {},
    },
  }),
}));

import { DELETE } from "../[id]/route";
import { GET } from "../route";

const del = (id: string) =>
  DELETE(new Request(`http://local/api/groups/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
const grant = (id: string, principalType: Grant["principalType"], principalId: string): Grant => ({
  id,
  resourceType: "agent",
  resourceId: `agent-${id}`,
  principalType,
  principalId,
  permission: "read",
});

beforeEach(async () => {
  state.user = "admin";
  state.role = "admin";
  audit.record.mockClear();
  groups = new FakeGroups();
  await groups.create({ id: "g1", name: "财务部", ownerId: "alice" });
  await groups.create({ id: "g2", name: "法务部", ownerId: "admin" });
  await groups.addMember("g1", "bob");
  await groups.addMember("g1", "carol");
  grants = [grant("a", "group", "g1"), grant("b", "group", "g1"), grant("c", "user", "g1")];
});

describe("GET /api/groups:管理页需要的字段", () => {
  it("scope=all 时管理员看到全部组,带成员数、创建者邮箱、用在几条授权上", async () => {
    const res = await GET(new Request("http://local/api/groups?scope=all"));
    const body = await res.json();
    expect(body.scope).toBe("all");
    const g1 = body.groups.find((g: { id: string }) => g.id === "g1");
    expect(g1).toMatchObject({
      name: "财务部",
      memberCount: 2,
      ownerEmail: "alice@example.test",
      grantCount: 2,
    });
    expect(body.groups.find((g: { id: string }) => g.id === "g2").grantCount).toBe(0);
  });
});

describe("DELETE /api/groups/[id]", () => {
  it("管理员可以删别人的组:成员清掉、经由这个组的授权一并收回,记审计", async () => {
    const res = await del("g1");
    expect(res.status).toBe(200);
    expect(await groups.get("g1")).toBeNull();
    expect(grants.map((g) => g.id)).toEqual(["c"]);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({
      action: "group.delete",
      resource: { type: "group", id: "g1" },
      ownerId: "alice",
      details: { name: "财务部", members: 2, revokedGrants: 2 },
    });
  });

  it("创建者可以删自己的组;别人删 404(不确认存在);不存在 404", async () => {
    state.user = "mallory";
    state.role = "user";
    expect((await del("g1")).status).toBe(404);
    expect(await groups.get("g1")).not.toBeNull();
    state.user = "alice";
    expect((await del("g1")).status).toBe(200);
    expect((await del("nope")).status).toBe(404);
  });
});
