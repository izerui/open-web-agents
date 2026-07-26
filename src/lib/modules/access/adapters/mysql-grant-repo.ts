import type { Db } from "@/lib/db/client";
import { accessGrants } from "@/lib/db/schema";
import type { Grant, Permission, ResourceType } from "@/lib/modules/access/domain/grants";
import type { GrantRepo, NewGrant } from "@/lib/modules/access/ports";
import { and, eq } from "drizzle-orm";

interface Row {
  id: string;
  resourceType: string;
  resourceId: string;
  principalType: string;
  principalId: string;
  permission: string;
}

const COLUMNS = {
  id: accessGrants.id,
  resourceType: accessGrants.resourceType,
  resourceId: accessGrants.resourceId,
  principalType: accessGrants.principalType,
  principalId: accessGrants.principalId,
  permission: accessGrants.permission,
};

function toGrant(r: Row): Grant {
  return {
    id: r.id,
    resourceType: r.resourceType as ResourceType,
    resourceId: r.resourceId,
    principalType: r.principalType as Grant["principalType"],
    principalId: r.principalId,
    permission: r.permission as Permission,
  };
}

export class MysqlGrantRepo implements GrantRepo {
  constructor(private readonly db: Db) {}

  async listForResource(resourceType: ResourceType, resourceId: string): Promise<Grant[]> {
    const rows = await this.db
      .select(COLUMNS)
      .from(accessGrants)
      .where(
        and(eq(accessGrants.resourceType, resourceType), eq(accessGrants.resourceId, resourceId)),
      );
    return rows.map(toGrant);
  }

  /**
   * 某类资源的全部授权。
   *
   * 【这里的截断性质与别处不同】—— 这份数据直接喂给授权判定。曾经是 limit(5000)
   * 且【没有 ORDER BY】,MySQL 返回任意且不稳定的子集:授权总数一旦超过上限
   * (60 个助手 × 100 个用户就到了),用户自己的那条 grant 可能落在返回集之外,
   * 已共享给他的助手就此从列表消失;更糟的是两次相同请求结果可能不同,
   * 界面上助手忽隐忽现。展示类截断顶多少看几条,这里是【把权限算错】。
   *
   * 故:定序保证可复现;上限提到真实自托管规模不会触发的量级;真触到了就告警 ——
   * 宁可吵,也不能静默地把权限算错。
   */
  async listForType(resourceType: ResourceType): Promise<Grant[]> {
    const cap = 50_000;
    const rows = await this.db
      .select(COLUMNS)
      .from(accessGrants)
      .where(eq(accessGrants.resourceType, resourceType))
      .orderBy(accessGrants.id)
      .limit(cap);
    if (rows.length === cap) {
      console.warn(`[owa] 授权记录达到 ${cap} 条上限,判定可能不完整 —— 应改为按资源查询或引入分页`);
    }
    return rows.map(toGrant);
  }

  /**
   * 授权。同一 主体+资源 再次授予视为改权限(而非堆叠两条),
   * 否则界面上会出现同一个人两条不同权限的记录、判定结果取决于顺序。
   */
  async grant(g: NewGrant): Promise<Grant> {
    const existing = (await this.listForResource(g.resourceType, g.resourceId)).find(
      (x) => x.principalType === g.principalType && x.principalId === g.principalId,
    );

    if (existing) {
      await this.db
        .update(accessGrants)
        .set({ permission: g.permission })
        .where(eq(accessGrants.id, existing.id));
      return { ...existing, permission: g.permission };
    }

    await this.db.insert(accessGrants).values(g);
    return { ...g };
  }

  async revoke(id: string): Promise<void> {
    await this.db.delete(accessGrants).where(eq(accessGrants.id, id));
  }

  async revokeAllForResource(resourceType: ResourceType, resourceId: string): Promise<void> {
    await this.db
      .delete(accessGrants)
      .where(
        and(eq(accessGrants.resourceType, resourceType), eq(accessGrants.resourceId, resourceId)),
      );
  }
}
