import path from "node:path";
import { loadEnv, parseEnv } from "@/lib/env";
import { afterEach, describe, expect, it } from "vitest";

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

// 开发默认密钥就写在开源仓库里,任何人都读得到。曾经生产环境缺配只 console.warn ——
// 服务照常起来、看起来一切正常,而攻击者可以用公开常量自签嵌入令牌接管任意会话,
// 或用同一常量解密 users.anthropic_key_enc 还原所有用户的明文密钥。
// 一条淹没在启动日志里的 warning 换不来这个风险。
describe("loadEnv / 【生产硬失败】不安全默认值不得静默生效", () => {
  const snapshot = { ...process.env };
  afterEach(() => {
    process.env = { ...snapshot };
  });

  const prodEnv = (over: Record<string, string | undefined>) => {
    process.env = {
      ...snapshot,
      NODE_ENV: "production",
      OWA_DATABASE_URL: "mysql://u:p@h:3306/d",
      OWA_REDIS_URL: "redis://h:6379",
      OWA_SESSION_SECRET: "real-session-secret",
      OWA_SECRET_KEY: "real-secret-key",
      ...over,
    } as NodeJS.ProcessEnv;
  };

  it("缺 OWA_SESSION_SECRET 时拒绝启动", () => {
    prodEnv({ OWA_SESSION_SECRET: undefined });
    expect(() => loadEnv()).toThrow(/OWA_SESSION_SECRET/);
  });

  it("缺 OWA_SECRET_KEY 时拒绝启动", () => {
    prodEnv({ OWA_SECRET_KEY: undefined });
    expect(() => loadEnv()).toThrow(/OWA_SECRET_KEY/);
  });

  it("两个都缺时错误信息把两个都列出来 —— 免得修一个重启再撞一次", () => {
    prodEnv({ OWA_SESSION_SECRET: undefined, OWA_SECRET_KEY: undefined });
    expect(() => loadEnv()).toThrow(/OWA_SESSION_SECRET.*OWA_SECRET_KEY/s);
  });

  it("都配齐了就正常启动", () => {
    prodEnv({});
    expect(loadEnv().sessionSecret).toBe("real-session-secret");
  });

  it("非生产环境仍允许用开发默认值(本地开箱即用)", () => {
    process.env = {
      ...snapshot,
      NODE_ENV: "development",
      OWA_DATABASE_URL: "mysql://u:p@h:3306/d",
      OWA_REDIS_URL: "redis://h:6379",
      OWA_SESSION_SECRET: undefined,
      OWA_SECRET_KEY: undefined,
    } as NodeJS.ProcessEnv;
    expect(() => loadEnv()).not.toThrow();
  });
});
