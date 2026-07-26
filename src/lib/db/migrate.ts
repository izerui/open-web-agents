import { loadEnv } from "@/lib/env";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createDb } from "./client";

export async function runMigrations(databaseUrl: string): Promise<void> {
  const { db, pool } = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations(loadEnv().databaseUrl)
    .then(() => {
      console.log("migrations applied");
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
