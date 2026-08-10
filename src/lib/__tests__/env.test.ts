import fs from "node:fs";
import os from "node:os";
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

  it("stdio MCP 默认关闭;只有显式真值才开启", () => {
    expect(parseEnv(base).allowStdioMcp).toBe(false);
    expect(parseEnv({ ...base, OWA_ALLOW_STDIO_MCP: "1" }).allowStdioMcp).toBe(true);
    expect(parseEnv({ ...base, OWA_ALLOW_STDIO_MCP: "true" }).allowStdioMcp).toBe(true);
    expect(parseEnv({ ...base, OWA_ALLOW_STDIO_MCP: "0" }).allowStdioMcp).toBe(false);
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

// dataDir 里只要有一段是符号链接,历史回放就会整个读不到 —— 而且不报错,是空白页。
//
// 【为什么 path.resolve 不够】SDK 拿到 cwd 后【先解析真实路径】再编码成 projects 子目录名,
// 而 resolve 只规范化 `..`/相对段,不解析符号链接。于是写入方按真实路径编码、
// 读取方按符号链接路径编码,两个目录名对不上:
//   SDK 写  -Users-x-real-workspaces-s1
//   我们读  -Users-x-link-workspaces-s1
// 实测(claude-agent-sdk 0.3.226)确认了这个解析行为。
//
// 【不是假想的部署形态】macOS 上 /tmp、/var、/etc 本身就是符号链接,运维把数据盘软链
// 出去(/app/data -> /mnt/volume/data)更是常规操作。而本地开发几乎永远复现不了。
describe("loadEnv / dataDir 必须解析符号链接", () => {
  const snapshot = { ...process.env };
  let tmp = "";

  afterEach(() => {
    process.env = { ...snapshot };
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  /** 造一对 real/link,返回经由 link 的 dataDir 路径与它的真实路径。 */
  const linkedDataDir = (createDataDir: boolean) => {
    // mkdtemp 的父目录本身可能是符号链接(macOS /var),先解析掉,免得干扰断言。
    tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "owa-env-"));
    const real = path.join(tmp, "real");
    fs.mkdirSync(real, { recursive: true });
    if (createDataDir) fs.mkdirSync(path.join(real, "data"));
    fs.symlinkSync(real, path.join(tmp, "link"));
    return {
      viaLink: path.join(tmp, "link", "data"),
      expected: path.join(real, "data"),
    };
  };

  const withDataDir = (dir: string) => {
    process.env = {
      ...snapshot,
      OWA_DATABASE_URL: "mysql://u:p@h:3306/d",
      OWA_REDIS_URL: "redis://h:6379",
      OWA_DATA_DIR: dir,
    } as NodeJS.ProcessEnv;
  };

  it("dataDir 经由符号链接时解析为真实路径", () => {
    const { viaLink, expected } = linkedDataDir(true);
    withDataDir(viaLink);
    expect(loadEnv().dataDir).toBe(expected);
  });

  // 首次启动时 data 目录还不存在,但符号链接在【祖先】上 —— 一样要解析,
  // 否则第一次跑完的历史就已经读不到了。
  it("dataDir 尚不存在时仍解析祖先上的符号链接", () => {
    const { viaLink, expected } = linkedDataDir(false);
    withDataDir(viaLink);
    expect(loadEnv().dataDir).toBe(expected);
  });

  it("路径中没有符号链接时行为不变", () => {
    const { expected } = linkedDataDir(true);
    withDataDir(expected);
    expect(loadEnv().dataDir).toBe(expected);
  });
});
