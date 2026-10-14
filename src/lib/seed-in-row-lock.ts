import type { Db } from "@/lib/db/client";
import { MysqlGrantRepo } from "@/lib/modules/access/adapters/mysql-grant-repo";
import type { NewGrant } from "@/lib/modules/access/ports";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import type { SeedBuiltinDeps } from "@/lib/modules/agent/application/seed-builtin";

/**
 * 跨 agent 与 access 两个模块的事务接线,属于组装层(与 container.ts 同级):
 * 模块之间只经公开面交互,不能由 agent 的 adapter 直接去用 access 的 adapter。
 *
 * 内置智能体播种的事务:智能体行与公开授权走同一个数据库事务,fn 抛错就一起回滚。
 * 行锁由 seedBuiltin 在事务开头取(agents.lockRow)。
 */
export function mysqlSeedInRowLock(db: Db, publicGrant: NewGrant): SeedBuiltinDeps["inRowLock"] {
  return (fn) =>
    db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const grants = new MysqlGrantRepo(txDb);
      return fn({
        agents: new MysqlAgentRepo(txDb),
        grantPublicRead: () => grants.grant(publicGrant).then(() => {}),
      });
    });
}
