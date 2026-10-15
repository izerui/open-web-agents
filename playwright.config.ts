import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./playwright",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678",
    headless: true,
    channel: "chromium",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
