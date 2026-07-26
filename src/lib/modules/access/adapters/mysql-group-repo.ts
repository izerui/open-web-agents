import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/client";
import { groupMembers, groups, users } from "@/lib/db/schema";
import type { Group, GroupMember, GroupRepo, NewGroup } from "@/lib/modules/access/group-ports";
import { and, desc, eq } from "drizzle-orm";

interface Row {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  createdAt: Date;
}

const COLUMNS = {
  id: groups.id,
  name: groups.name,
  description: groups.description,
  ownerId: groups.ownerId,
  createdAt: groups.createdAt,
};

function toGroup(r: Row): Group {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    ownerId: r.ownerId,
    createdAt: r.createdAt.getTime(),
  };
}

export class MysqlGroupRepo implements GroupRepo {
  constructor(private readonly db: Db) {}

  async create(g: NewGroup): Promise<Group> {
    await this.db.insert(groups).values(g);
    const created = await this.get(g.id);
    if (!created) throw new Error(`group insert failed: ${g.id}`);
    return created;
  }

  async get(id: string): Promise<Group | null> {
    const rows = await this.db.select(COLUMNS).from(groups).where(eq(groups.id, id)).limit(1);
    const row = rows[0];
    return row ? toGroup(row) : null;
  }

  async list(ownerId?: string): Promise<Group[]> {
    const q = this.db.select(COLUMNS).from(groups);
    const rows = await (ownerId ? q.where(eq(groups.ownerId, ownerId)) : q)
      .orderBy(desc(groups.createdAt))
      .limit(500);
    return rows.map(toGroup);
  }

  async delete(id: string): Promise<void> {
    // 先清成员再删组,避免留下指向不存在组的悬挂成员记录
    await this.db.delete(groupMembers).where(eq(groupMembers.groupId, id));
    await this.db.delete(groups).where(eq(groups.id, id));
  }

  async groupIdsOf(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(eq(groupMembers.userId, userId));
    return rows.map((r) => r.groupId);
  }

  async members(groupId: string): Promise<GroupMember[]> {
    const rows = await this.db
      .select({
        userId: groupMembers.userId,
        email: users.email,
        joinedAt: groupMembers.createdAt,
      })
      .from(groupMembers)
      .innerJoin(users, eq(groupMembers.userId, users.id))
      .where(eq(groupMembers.groupId, groupId));
    return rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      joinedAt: r.joinedAt.getTime(),
    }));
  }

  /** 重复加入是幂等的 —— 靠 (group_id, user_id) 唯一约束兜底,重复时静默通过。 */
  async addMember(groupId: string, userId: string): Promise<void> {
    try {
      await this.db.insert(groupMembers).values({
        id: randomUUID().replace(/-/g, "").slice(0, 24),
        groupId,
        userId,
      });
    } catch (err) {
      // 唯一键冲突 = 已是成员,视为成功
      const code = (err as { code?: string }).code;
      if (code !== "ER_DUP_ENTRY") throw err;
    }
  }

  async removeMember(groupId: string, userId: string): Promise<void> {
    await this.db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
  }
}
