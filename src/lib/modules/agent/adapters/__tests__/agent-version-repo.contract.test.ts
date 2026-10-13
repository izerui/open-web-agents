// 同一套契约,两个 adapter 都必须通过。
// MySQL 用例需要真实数据库:未配置 OWA_TEST_DATABASE_URL 时跳过并明确说明(不静默假过)。
// 每条用例用随机的智能体 id,不清表 —— 测试库里别的契约测试的数据不受影响。

import { createDb } from "@/lib/db/client";
import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { InMemoryAgentVersionRepo } from "@/lib/modules/agent/adapters/in-memory-agent-version-repo";
import { MysqlAgentRepo } from "@/lib/modules/agent/adapters/mysql-agent-repo";
import { MysqlAgentVersionRepo } from "@/lib/modules/agent/adapters/mysql-agent-version-repo";
import { agentVersionRepoContract } from "@/lib/modules/agent/versions.contract";
import { afterAll } from "vitest";

agentVersionRepoContract("InMemoryAgentVersionRepo", {
  make: async () => {
    const agents = new InMemoryAgentRepo();
    return { agents, versions: new InMemoryAgentVersionRepo(agents) };
  },
});

const TEST_DB_URL = process.env.OWA_TEST_DATABASE_URL;

if (!TEST_DB_URL) {
  console.warn(
    "[skip] AgentVersionRepo 的 MySQL 契约未运行 —— 需设置 OWA_TEST_DATABASE_URL 指向测试库",
  );
} else {
  if (!/test/i.test(new URL(TEST_DB_URL).pathname)) {
    throw new Error("OWA_TEST_DATABASE_URL 的库名须含 test");
  }
  const { db, pool } = createDb(TEST_DB_URL);
  agentVersionRepoContract("MysqlAgentVersionRepo(真实 MySQL)", {
    make: async () => ({ agents: new MysqlAgentRepo(db), versions: new MysqlAgentVersionRepo(db) }),
  });
  afterAll(async () => {
    await pool.end();
  });
}
