import { createDb } from "@/lib/db/client";
import { afterAll, describe, it } from "vitest";
import { providerContract } from "../../ports.contract";
import { MysqlModelAliasRepo, MysqlProviderRepo } from "../mysql-provider-repo";

const url = process.env.OWA_TEST_DATABASE_URL;
if (!url) {
  describe.skip("model providers: MySQL requires OWA_TEST_DATABASE_URL", () => {
    it("requires test database", () => {});
  });
} else {
  if (!/test/i.test(new URL(url).pathname)) throw new Error("Dedicated test database required");
  const { db, pool } = createDb(url);
  afterAll(() => pool.end());
  providerContract("MySQL", () => ({
    providers: new MysqlProviderRepo(db),
    aliases: new MysqlModelAliasRepo(db),
  }));
}
