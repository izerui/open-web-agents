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
  // 别名槽 → 真实 modelId。未单独配置的槽回退到 OWA_MODEL(单模型部署)
  OWA_MODEL: z.string().default("sonnet"),
  OWA_MODEL_FABLE: z.string().default(""),
  OWA_MODEL_OPUS: z.string().default(""),
  OWA_MODEL_SONNET: z.string().default(""),
  OWA_MODEL_HAIKU: z.string().default(""),
  // 会话签名与用户密钥加密的主密钥。生产必须显式设置;未设时用开发默认值并在启动时告警
  OWA_SESSION_SECRET: z.string().default(""),
  OWA_SECRET_KEY: z.string().default(""),
  // 关掉登录(仅本地开发用;设为 0/false 即要求登录)
  OWA_AUTH_REQUIRED: z
    .preprocess(
      (v) =>
        v === undefined || v === ""
          ? true
          : !["0", "false", "off", "no"].includes(String(v).toLowerCase()),
      z.boolean(),
    )
    .default(true),
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
  /** 别名槽的真实 modelId 配置 */
  models: { base: string; fable: string; opus: string; sonnet: string; haiku: string };
  /** 登录会话签名密钥 */
  sessionSecret: string;
  /** 用户凭证加密主密钥 */
  secretKey: string;
  /** 是否要求登录 */
  authRequired: boolean;
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
    models: {
      base: p.OWA_MODEL,
      fable: p.OWA_MODEL_FABLE,
      opus: p.OWA_MODEL_OPUS,
      sonnet: p.OWA_MODEL_SONNET,
      haiku: p.OWA_MODEL_HAIKU,
    },
    // 开发默认值:能跑起来,但生产必须显式配置(见 loadEnv 的告警)
    sessionSecret: p.OWA_SESSION_SECRET || "dev-insecure-session-secret",
    secretKey: p.OWA_SECRET_KEY || "dev-insecure-secret-key",
    authRequired: p.OWA_AUTH_REQUIRED,
    sandbox: p.OWA_SANDBOX,
  };
}

export function loadEnv(): Env {
  const env = parseEnv(process.env);
  // 用开发默认密钥跑生产 = 任何人都能伪造登录会话、解密用户密钥,必须显式告警
  if (process.env.NODE_ENV === "production") {
    if (!process.env.OWA_SESSION_SECRET) {
      console.warn("[owa] 警告:未设置 OWA_SESSION_SECRET,正在使用开发默认值(会话可被伪造)");
    }
    if (!process.env.OWA_SECRET_KEY) {
      console.warn("[owa] 警告:未设置 OWA_SECRET_KEY,正在使用开发默认值(用户密钥可被解密)");
    }
  }
  return env;
}
