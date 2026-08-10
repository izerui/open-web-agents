import fs from "node:fs";
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
  // stdio MCP 会在平台宿主机直接启动进程,不受 agent 沙箱约束,必须显式开启。
  OWA_ALLOW_STDIO_MCP: z
    .preprocess(
      (v) => ["1", "true", "on", "yes"].includes(String(v ?? "").toLowerCase()),
      z.boolean(),
    )
    .default(false),
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
  /** 是否允许助手配置在宿主机启动 stdio MCP 进程。 */
  allowStdioMcp: boolean;
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
    allowStdioMcp: p.OWA_ALLOW_STDIO_MCP,
  };
}

/**
 * 解析掉路径里的符号链接。
 *
 * 【为什么 path.resolve 不够】SDK 拿到 cwd 后【先解析真实路径】,再把它编码成
 * transcript 的 projects 子目录名;而 resolve 只处理 `..` 与相对段,不碰符号链接。
 * dataDir 里只要有一段是软链,写入方按真实路径编码、读取方按软链路径编码,
 * 两个目录名就对不上 —— 历史回放整个读不到,且表现是空白页不是报错。
 *
 * 【目录可能还不存在】首次启动时 data/ 尚未创建,realpath 会 ENOENT。但符号链接
 * 只可能在【已存在的祖先】上,所以逐级回退到最长的已存在前缀去解析,再把剩余段拼回来。
 * 一路退到根都不存在(理论上不会发生)就原样返回,不让路径解析拖垮启动。
 */
function realpathBestEffort(dir: string): string {
  let head = dir;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return dir;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

export function loadEnv(): Env {
  const env = parseEnv(process.env);
  env.dataDir = realpathBestEffort(env.dataDir);
  /**
   * 生产环境缺密钥【直接拒绝启动】,不再只是告警。
   *
   * 这两个默认值就写在开源仓库里,任何人都读得到。只 warn 的后果是:部署方漏配一个
   * 环境变量 → 服务照常起来、看起来一切正常 → 攻击者用公开常量自签嵌入令牌接管任意
   * 会话,或用同一常量解密 users.anthropic_key_enc 列,还原所有用户的明文密钥。
   *
   * 一条淹没在启动日志里的 warning 换不来这个风险。不安全的默认值在生产必须是硬失败。
   */
  if (process.env.NODE_ENV === "production") {
    const missing: string[] = [];
    if (!process.env.OWA_SESSION_SECRET) missing.push("OWA_SESSION_SECRET(会话可被伪造)");
    if (!process.env.OWA_SECRET_KEY) missing.push("OWA_SECRET_KEY(用户密钥可被解密)");
    if (missing.length > 0) {
      throw new Error(
        `[owa] 生产环境拒绝以开发默认密钥启动 —— 缺少:${missing.join("、")}。请用 \`openssl rand -base64 32\` 生成后配置并重启。`,
      );
    }
  }
  return env;
}
