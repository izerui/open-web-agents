import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
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
  capabilityContract("MySQL", () => new MysqlCapabilityRepo(db));
  it("model metering survives persistence and the public run-result contract", async () => {
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
      expect(toRunResult(record).cost?.metering).toEqual(metering);
      await repo.saveResult(id, { error: { kind: "later_error" } });
      expect((await repo.getResult(id))?.cost).toMatchObject({ metering });
    } finally {
      await db.delete(runs).where(eq(runs.id, id));
    }
  });
}
