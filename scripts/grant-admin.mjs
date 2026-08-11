// 授予 / 撤销管理员角色 —— 带外的救急通道。
//
// 【日常请用界面】平台管理 → 账号管理(/admin/accounts)已经能提升、
// 取消管理员和停用账号了。那里有界面该有的防护:不能改自己、
// 不能降掉最后一位管理员。
//
// 【那这个脚本还留着干嘛】它守的是界面进不去的那种情况:
//   - 唯一的管理员账号被删了 / 密码丢了 → 没有任何人能登进管理区
//   - 数据被手工改坏,库里一个 admin 都不剩
// 这时界面本身就是锁在门里的东西,只能靠能连数据库的人从外面开锁。
//
// 【为什么这个能力不做成接口】提权必须要有带外的凭据(能连数据库)。
// 做成登录后可调的接口,等于给越权提升开了一条路。运维动作留在运维层。
//
// 用法:
//   node scripts/grant-admin.mjs --list                 # 看看现在谁是管理员
//   node scripts/grant-admin.mjs <email>                # 提升为管理员
//   node scripts/grant-admin.mjs <email> --revoke       # 降回普通用户
//
// 连接信息取自 OWA_DATABASE_URL。

import mysql from "mysql2/promise";

const args = process.argv.slice(2);
const wantList = args.includes("--list");
const wantRevoke = args.includes("--revoke");
const email = args.find((a) => !a.startsWith("--"));

if (!wantList && !email) {
  console.error("用法:node scripts/grant-admin.mjs <email> [--revoke]");
  console.error("     node scripts/grant-admin.mjs --list");
  process.exit(1);
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

/** 打印当前所有管理员 —— 每次操作前后都看一眼,避免"改完了不知道改成什么样"。 */
async function listAdmins(label) {
  const [rows] = await conn.query("SELECT email FROM users WHERE role = 'admin' ORDER BY email");
  console.log(`${label}管理员(${rows.length} 位):`);
  if (rows.length === 0) console.log("  (一个都没有)");
  for (const r of rows) console.log(`  ${r.email}`);
}

try {
  if (wantList) {
    await listAdmins("当前");
    process.exit(0);
  }

  const [found] = await conn.query("SELECT id, email, role FROM users WHERE email = ?", [email]);
  const target = found[0];
  if (!target) {
    console.error(`找不到用户:${email}`);
    console.error("(邮箱要和注册时完全一致)");
    process.exit(1);
  }

  const nextRole = wantRevoke ? "user" : "admin";
  if (target.role === nextRole) {
    console.log(`${email} 已经是 ${nextRole} 了,无需改动。`);
    await listAdmins("当前");
    process.exit(0);
  }

  /*
   * 【为什么撤销时要拦一下】把最后一个管理员降级,等于把平台管理锁死 ——
   * 而且没有任何界面能再把它打开,只能再跑一次这个脚本。
   * 这一步不可逆的代价太大,值得挡在前面。
   */
  if (wantRevoke) {
    const [admins] = await conn.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
    if (Number(admins[0].n) <= 1) {
      console.error(`拒绝执行:${email} 是最后一个管理员。`);
      console.error("降级后平台管理将没有任何人能进入,且只能靠再跑一次本脚本恢复。");
      console.error("要真这么做,请先把别人提升为管理员。");
      process.exit(1);
    }
  }

  await conn.query("UPDATE users SET role = ? WHERE id = ?", [nextRole, target.id]);
  console.log(`✓ ${email}:${target.role} → ${nextRole}`);
  console.log();
  await listAdmins("现在的");
  console.log();
  console.log("提示:该用户需要重新登录,新角色才会反映到界面上。");
} finally {
  await conn.end();
}
