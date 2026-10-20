import type { Db } from "@/lib/db/client";
import { MysqlGrantRepo } from "@/lib/modules/access/adapters/mysql-grant-repo";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import { MysqlAgentVersionRepo } from "@/lib/modules/agent/adapters/mysql-agent-version-repo";
import type { DesignerDeps } from "@/lib/modules/agent/application/designer";
import { AgentReleases } from "@/lib/modules/agent/application/releases";
import { MysqlRunChargeStore } from "@/lib/modules/billing/adapters/mysql-run-charge-store";
import type { RunCharging } from "@/lib/modules/billing/application/run-charging";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { type ChargedCreate, RunEnqueuer } from "@/lib/modules/run/application/enqueue";
import { MysqlSessionRepo } from "@/lib/modules/session/adapters/mysql-session-repo";
import { sql } from "drizzle-orm";

/** 在给定连接上做"计费受理 + 插入运行"。连接是事务时两者随它一起提交或回滚。 */
function chargedOn(txDb: Db, charging: RunCharging): ChargedCreate {
  return (fn) => {
    const store = new MysqlRunChargeStore(txDb);
    return fn({
      runs: new MysqlRunRepo(txDb),
      lockAccount: async (accountId) => {
        await store.lockAccount(accountId);
      },
      admit: (req) => charging.admit(store, req),
    });
  };
}

/** 入队用:每次受理单独开一个事务,冻结、run_charges 与运行记录一起提交。 */
export function chargedCreate(db: Db, charging: RunCharging): ChargedCreate {
  return (fn) =>
    db.transaction((tx) => chargedOn(tx as unknown as Db, charging)(fn), {
      isolationLevel: "read committed",
    });
}

/** 复用业务仓储及会话行锁;设计不是另一套队列或执行器。 */
export function designTransaction(db: Db, charging?: RunCharging): DesignerDeps["inSession"] {
  return (id, fn) =>
    db.transaction(
      async (tx) => {
        await tx.execute(sql`SELECT id FROM sessions WHERE id = ${id} FOR UPDATE`);
        const txDb = tx as unknown as Db;
        const agents = new MysqlAgentRepo(txDb);
        const sessions = new MysqlSessionRepo(txDb);
        const runs = new MysqlRunRepo(txDb);
        const enqueuer = new RunEnqueuer({
          agents,
          sessions,
          runs,
          releases: new AgentReleases(agents, new MysqlAgentVersionRepo(txDb)),
          // 设计的计费受理跟设计事务同进退:拒绝或失败时设计改动一起回滚
          ...(charging ? { charged: chargedOn(txDb, charging) } : {}),
        });
        return fn({
          agents,
          sessions,
          runs,
          grants: new MysqlGrantRepo(txDb),
          busy: async () => {
            const result = await tx.execute(
              sql`SELECT id FROM runs WHERE session_id = ${id} AND status IN ('pending', 'running') LIMIT 1`,
            );
            return (result as unknown as [unknown[]])[0].length > 0;
          },
          enqueue: (request) => enqueuer.enqueue(request),
        });
      },
      { isolationLevel: "read committed" },
    );
}
