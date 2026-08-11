// 重置某个用户的登录密码。
//
// 【为什么需要】密码只存 scrypt 哈希,任何人(包括运维)都读不出明文 ——
// 这是对的。但代价是:账号密码一旦遗失,产品里没有任何路径能把它找回来
// (没有邮件服务,也就没有"忘记密码"流程)。对于平台上唯一的管理员账号,
// 这意味着整个管理区可能被永久锁死。
//
// 【为什么复用 src 里的 hashPassword,而不在这儿现写一遍】
// 存储格式是 `scrypt$N$r$p$salt$hash`,参数随哈希一起存。自己拼一份
// 看起来一样的字符串,只要有一处对不上(参数、keylen、base64 变体),
// 写进去的哈希就永远验证不过 —— 而且要等到有人登录失败才会发现。
// 单一来源在这里不是洁癖,是正确性。
//
// 用法(需要 tsx,项目已有):
//   npx tsx scripts/reset-password.mjs <email>                 # 生成随机强密码
//   npx tsx scripts/reset-password.mjs <email> --password xxx  # 自己指定
//
// 连接信息取自 OWA_DATABASE_URL。

import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { hashPassword, verifyPassword } from "../src/lib/modules/identity/domain/password.ts";

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"));
const pwIdx = args.indexOf("--password");
const given = pwIdx >= 0 ? args[pwIdx + 1] : undefined;

if (!email) {
  console.error("用法:npx tsx scripts/reset-password.mjs <email> [--password <明文>]");
  process.exit(1);
}
if (pwIdx >= 0 && !given) {
  console.error("--password 后面要跟一个密码");
  process.exit(1);
}

const MIN_LEN = 12;
if (given && given.length < MIN_LEN) {
  console.error(`密码太短(至少 ${MIN_LEN} 位)。这是管理入口,别用弱口令。`);
  process.exit(1);
}

/**
 * 随机密码。
 * 【为什么排除易混字符】0/O、1/l/I 在终端字体里长得几乎一样,
 * 抄错一个字符换来的是一次"密码明明对却登不上"的排查。
 */
function randomPassword(len = 24) {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const raw = process.env.OWA_DATABASE_URL;
if (!raw) {
  console.error("需要 OWA_DATABASE_URL(可以先 `set -a; . ./.env.local; set +a`)");
  process.exit(1);
}

const u = new URL(raw);
const conn = await mysql.createConnection({
  host: u.hostname,
  port: Number(u.port || 3306),
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.slice(1),
});

try {
  const [found] = await conn.query("SELECT id, email, role FROM users WHERE email = ?", [email]);
  const target = found[0];
  if (!target) {
    console.error(`找不到用户:${email}`);
    process.exit(1);
  }

  const plain = given ?? randomPassword();
  const hash = await hashPassword(plain);

  /*
   * 【为什么写库前先自校验】哈希算错了不会有任何报错,只会让这个账号
   * 从此登不进去 —— 而原来的密码已经被覆盖,没有回头路。
   * 花几十毫秒验一次,把"改完就锁死"这种不可逆的错挡在写入之前。
   */
  if (!(await verifyPassword(plain, hash))) {
    console.error("自校验失败:生成的哈希验证不通过,已中止,数据库未改动。");
    process.exit(1);
  }

  await conn.query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, target.id]);

  console.log(`✓ 已重置 ${target.email}(${target.role})的密码`);
  console.log();
  console.log("  新密码:", plain);
  console.log();
  console.log("这串明文只在这里出现这一次 —— 数据库里存的是哈希,再也取不出来。");
  console.log("请立刻记到密码管理器里,并清理你的终端记录。");
} finally {
  await conn.end();
}
