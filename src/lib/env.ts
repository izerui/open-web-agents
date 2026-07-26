import path from "node:path";
import { z } from "zod";

/**
 * 平台环境配置。所有变量以 OWA_ 前缀。
 * dataDir 强制解析为绝对路径:agent 的 cwd 由此派生,相对路径会随 agent 在 Bash 里 cd 而漂移,
 * 导致工具把产物吐进源码树。
 */
const schema = z.object({
  OWA_DATABASE_URL: z.string().startsWith("mysql://"),
  OWA_REDIS_URL: z.string().startsWith("redis://"),
  OWA_DATA_DIR: z.string().default("./data"),
  OWA_ANTHROPIC_BASE_URL: z.string().default("https://api.anthropic.com"),
  OWA_ANTHROPIC_API_KEY: z.string().default(""),
  OWA_SANDBOX: z
    .preprocess(
      (v) =>
        v === undefined || v === ""
          ? true
          : !["0", "false", "off", "no"].includes(String(v).toLowerCase()),
      z.boolean(),
    )
    .default(true),
});

export interface Env {
  databaseUrl: string;
  redisUrl: string;
  /** 绝对路径 */
  dataDir: string;
  /** 平台默认凭证:用户/会话/请求都没配时的兜底 */
  defaultBaseUrl: string;
  defaultApiKey: string;
  sandbox: boolean;
}

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const p = schema.parse(raw);
  return {
    databaseUrl: p.OWA_DATABASE_URL,
    redisUrl: p.OWA_REDIS_URL,
    dataDir: path.resolve(p.OWA_DATA_DIR),
    defaultBaseUrl: p.OWA_ANTHROPIC_BASE_URL,
    defaultApiKey: p.OWA_ANTHROPIC_API_KEY,
    sandbox: p.OWA_SANDBOX,
  };
}

export function loadEnv(): Env {
  return parseEnv(process.env);
}
