import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { MysqlProviderRepo } from "@/lib/modules/model-gateway/adapters/mysql-provider-repo";
import { MysqlRunRepo } from "@/lib/modules/run/adapters/mysql-run-repo";
import { toRunResult } from "@/lib/modules/run/domain/run-result";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { capabilityContract } from "../../ports.contract";
import { MysqlCapabilityRepo } from "../mysql-capability-repo";

const url = process.env.OWA_TEST_DATABASE_URL;
if (!url) {
  describe.skip("capability versions: MySQL requires OWA_TEST_DATABASE_URL", () => {
    it("requires test database", () => {});
  });
} else {
  if (!/test/i.test(new URL(url).pathname)) throw new Error("Dedicated test database required");
  const { db, pool } = createDb(url);
  afterAll(() => pool.end());
  const providers = new MysqlProviderRepo(db);
  capabilityContract(
    "MySQL",
    () => new MysqlCapabilityRepo(db),
    async (id) => {
      await providers.save({ id, name: `测试-${id}`, enabled: true, endpoints: {} }, null, "test");
    },
  );
  it("model metering survives persistence but stays out of the public run-result contract", async () => {
    const repo = new MysqlRunRepo(db);
    const id = randomUUID();
    const metering = {
      source: "sdk_model_usage",
      complete: true,
      models: [
        {
          modelId: "actual-model",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 40,
        },
      ],
    };
    try {
      await repo.create({ id, sessionId: `usage-${randomUUID().slice(0, 16)}`, prompt: "test" });
      await repo.saveResult(id, { cost: { input: 100, output: 20, metering } });
      const record = await repo.getResult(id);
      if (!record) throw new Error("missing run");
      // 原始计量(含上游模型标识)只在库里;对外结果契约不带
      expect(record.cost).toMatchObject({ metering });
      expect(JSON.stringify(toRunResult(record))).not.toContain("actual-model");
      expect(toRunResult(record).cost).toMatchObject({ input: 100, output: 20 });
      await repo.saveResult(id, { error: { kind: "later_error" } });
      expect((await repo.getResult(id))?.cost).toMatchObject({ metering });
    } finally {
      await db.delete(runs).where(eq(runs.id, id));
    }
  });
}
