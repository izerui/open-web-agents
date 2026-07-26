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
    return Response.json({ authenticated: false, authRequired: env.authRequired });
  }
  const decrypted = user.anthropicKeyEnc ? secrets.decrypt(user.anthropicKeyEnc) : null;
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
    },
  });
}

interface Body {
  action?: "login" | "register" | "logout";
  email?: string;
  password?: string;
}

/** 登录 / 注册 / 登出。 */
export async function POST(req: Request) {
  const { authService } = getContainer();
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

  try {
    const { user, cookie } =
      body.action === "register"
        ? await authService.register(body.email, body.password)
        : await authService.login(body.email, body.password);

    return new Response(
      JSON.stringify({ user: { id: user.id, email: user.email, role: user.role } }),
      { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": cookie } },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
