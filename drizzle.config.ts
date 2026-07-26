import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "mysql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.OWA_DATABASE_URL ?? "mysql://root:owa@localhost:3306/owa",
  },
});
