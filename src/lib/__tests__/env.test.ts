import path from "node:path";
import { parseEnv } from "@/lib/env";
import { describe, expect, it } from "vitest";

const base = {
  OWA_DATABASE_URL: "mysql://root:owa@localhost:3306/owa",
  OWA_REDIS_URL: "redis://localhost:6379",
};

describe("parseEnv", () => {
  it("解析合法配置", () => {
    const env = parseEnv({ ...base, OWA_DATA_DIR: "./data" });
    expect(env.databaseUrl).toContain("mysql://");
    expect(env.redisUrl).toBe("redis://localhost:6379");
  });

  it("dataDir 解析为绝对路径(防 agent cd 漂移)", () => {
    const env = parseEnv({ ...base, OWA_DATA_DIR: "./data" });
    expect(path.isAbsolute(env.dataDir)).toBe(true);
    expect(env.dataDir).toBe(path.resolve("./data"));
  });

  it("缺 database url 抛错", () => {
    expect(() => parseEnv({ OWA_REDIS_URL: "redis://localhost:6379" })).toThrow();
  });

  it("database url 协议不对抛错", () => {
    expect(() => parseEnv({ ...base, OWA_DATABASE_URL: "postgres://x" })).toThrow();
  });

  it("sandbox 默认开;显式 0 关", () => {
    expect(parseEnv(base).sandbox).toBe(true);
    expect(parseEnv({ ...base, OWA_SANDBOX: "0" }).sandbox).toBe(false);
    expect(parseEnv({ ...base, OWA_SANDBOX: "false" }).sandbox).toBe(false);
  });

  it("平台默认凭证有兜底", () => {
    expect(parseEnv(base).defaultBaseUrl).toBe("https://api.anthropic.com");
    expect(parseEnv({ ...base, OWA_ANTHROPIC_API_KEY: "sk-x" }).defaultApiKey).toBe("sk-x");
  });
});
