import type { Db } from "@/lib/db/client";
import { MysqlGrantRepo } from "@/lib/modules/access/adapters/mysql-grant-repo";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import { MysqlAgentVersionRepo } from "@/lib/modules/agent/adapters/mysql-agent-version-repo";
import type { DesignerDeps } from "@/lib/modules/agent/application/designer";
import { AgentReleases } from "@/lib/modules/agent/application/releases";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { RunEnqueuer } from "@/lib/modules/run/application/enqueue";
import { MysqlSessionRepo } from "@/lib/modules/session/adapters/mysql-session-repo";
import { sql } from "drizzle-orm";

/** 复用业务仓储及会话行锁;设计不是另一套队列或执行器。 */
export function designTransaction(db: Db): DesignerDeps["inSession"] {
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
