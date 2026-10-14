import { getContainer } from "@/lib/container";
import { AuthError } from "@/lib/modules/identity/application/auth-service";
import { maskSecret } from "@/lib/modules/identity/domain/secret-box";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 当前登录态。未登录返回 authenticated:false(而非 401),便于前端决定是否跳登录页。 */
export async function GET(req: Request) {
  const { authService, env, secrets } = getContainer();
  const user = await authService.currentUser(req);
  if (!user) {
    return Response.json({
      authenticated: false,
      authRequired: env.authRequired,
      allowSignup: env.allowSignup,
    });
  }
  const decrypted = user.anthropicKeyEnc ? secrets.decrypt(user.anthropicKeyEnc) : null;
  const webhookSecret = user.webhookSecretEnc ? secrets.decrypt(user.webhookSecretEnc) : null;
  return Response.json({
    authenticated: true,
    authRequired: env.authRequired,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      defaultBaseUrl: user.defaultBaseUrl ?? null,
      // 只回掩码,永不回明文
      anthropicKeyMask: decrypted ? maskSecret(decrypted) : null,
      webhookSecretMask: webhookSecret ? maskSecret(webhookSecret) : null,
    },
  });
}

interface Body {
  action?: "login" | "register" | "logout";
  email?: string;
  password?: string;
}

/** 客户端地址:反向代理后取 X-Forwarded-For 的第一段。只用于限流计数,不用于鉴权。 */
function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

const MINUTE = 60_000;

/** 登录 / 注册 / 登出。 */
export async function POST(req: Request) {
  const { authService, rateLimiter, env, audit, users } = getContainer();
  const body = (await req.json().catch(() => ({}))) as Body;

  if (body.action === "logout") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": authService.logoutCookie() },
    });
  }

  if (body.action !== "login" && body.action !== "register") {
    return Response.json({ error: "action must be login/register/logout" }, { status: 400 });
  }
  if (!body.email || !body.password) {
    return Response.json({ error: "email and password are required" }, { status: 400 });
  }

  /*
   * 限流:防撞库与批量注册。曾经登录完全不限次数。
   * 按账号限住对单个账号的猜密码,按来源地址限住对大量账号的轮询。
   */
  const ip = clientIp(req);
  const email = body.email.trim().toLowerCase();
  const ipLimit = env.authIpRateLimit;
  const checks =
    body.action === "login" ? [rateLimiter.hit(`login:acct:${email}`, 10, 15 * MINUTE)] : [];
  if (ipLimit > 0) {
    checks.push(rateLimiter.hit(`${body.action}:ip:${ip}`, ipLimit, 15 * MINUTE));
  }
  const blocked = (await Promise.all(checks)).find((v) => !v.allowed);
  if (blocked) {
    const seconds = Math.ceil(blocked.retryAfterMs / 1000);
    return Response.json(
      { error: `尝试次数过多,请 ${Math.ceil(seconds / 60)} 分钟后再试` },
      { status: 429, headers: { "Retry-After": String(seconds) } },
    );
  }

  try {
    const { user, cookie } =
      body.action === "register"
        ? await authService.register(body.email, body.password)
        : await authService.login(body.email, body.password);

    await audit.record({
      actor: { type: "web", userId: user.id },
      action: body.action === "register" ? "auth.register" : "auth.login",
      resource: { type: "account", id: user.id },
      ownerId: user.id,
      req,
    });

    return new Response(
      JSON.stringify({ user: { id: user.id, email: user.email, role: user.role } }),
      { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": cookie } },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      if (body.action === "login") {
        /*
         * 登录失败也记:账号存在时记在该账号名下,本人能看到"有人在试我的密码";
         * 账号不存在的只有管理员看得到(撞库排查)。尝试的密码当然不记。
         */
        // 归属查询只为审计服务,放进构造函数,受审计总上限约束(登录结果已经确定)
        await audit.record(async () => {
          const target = await users.findByEmail(email).catch(() => null);
          return {
            actor: { type: "anonymous" },
            action: "auth.login_failed",
            resource: { type: "account", id: target?.id },
            ownerId: target?.id,
            /*
             * 只在账号确实存在时记邮箱。用户常把密码误输进邮箱框,
             * 不存在的"邮箱"可能就是一个密码 —— 那种情况什么输入都不记。
             */
            details: target
              ? { email: target.email, reason: err.message }
              : { reason: err.message },
            req,
          };
        });
      }
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
