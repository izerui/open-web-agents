import { getContainer } from "@/lib/container";
import { AuthError } from "@/lib/modules/identity/application/auth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 修改自己的登录密码。必须给出当前密码。 */
export async function PUT(req: Request) {
  const { authService, rateLimiter } = getContainer();
  const user = await authService.currentUser(req);
  if (!user) return Response.json({ error: "login required" }, { status: 401 });

  // 当前密码校验同样可以被用来猜密码,与登录同样限次
  const v = await rateLimiter.hit(`password:acct:${user.id}`, 10, 15 * 60_000);
  if (!v.allowed) {
    return Response.json({ error: "尝试次数过多,请稍后再试" }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as { current?: string; next?: string };
  if (!body.current || !body.next) {
    return Response.json({ error: "current 与 next 都是必填" }, { status: 400 });
  }
  try {
    await authService.changePassword(user.id, body.current, body.next);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
