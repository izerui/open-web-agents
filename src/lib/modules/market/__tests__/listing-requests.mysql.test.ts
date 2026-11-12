import { createDb } from "@/lib/db/client";
import { marketListingRequests } from "@/lib/db/schema";
import { like } from "drizzle-orm";
import { afterAll, describe } from "vitest";
import { MysqlListingRequestRepo } from "../adapters/mysql-listing-request-repo";
import { listingRequestContract } from "./listing-request-contract";

const databaseUrl = process.env.OWA_TEST_DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== "/owa_test") {
  throw new Error("Listing request SQL tests require the dedicated owa_test database");
}

describe.skipIf(!databaseUrl)("上架申请 SQL 契约", () => {
  const connection = databaseUrl ? createDb(databaseUrl) : undefined;
  const prefix = `t${Date.now().toString(36)}`;

  afterAll(async () => {
    if (!connection) return;
    try {
      await connection.db
        .delete(marketListingRequests)
        .where(like(marketListingRequests.id, `${prefix}%`));
    } finally {
      await connection.pool.end();
    }
  });

  listingRequestContract(
    "MysqlListingRequestRepo",
    () => {
      if (!connection) throw new Error("test database not configured");
      return new MysqlListingRequestRepo(connection.db);
    },
    prefix,
  );
});
