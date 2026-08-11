import { getContainer } from "@/lib/container";
import type { User } from "@/lib/modules/identity/user-ports";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * 从当前请求的 cookie 解析登录用户(服务端组件用)。
 *
 * 【为什么要拼一个 Request】authService.currentUser 的入参是标准 Request,
 * 这样它在 API 路由和服务端组件里是同一份逻辑 —— 不必为页面再写一套 cookie 解析。
 */
export async function currentUserFromCookies(): Promise<User | null> {
  const { authService } = getContainer();
  const h = await headers();
  const req = new Request("http://internal/", { headers: { cookie: h.get("cookie") ?? "" } });
  return authService.currentUser(req);
}

/** 未登录就送去登录页。关闭登录要求时(本地开发)直接放行。 */
export async function requireLogin(): Promise<void> {
  const { env } = getContainer();
  if (!env.authRequired) return;
  if (!(await currentUserFromCookies())) redirect("/login");
}

/**
 * 管理员页面守卫。
 *
 * 【为什么前端隐藏入口还不够】设置区侧栏对非 admin 不渲染"平台管理"分组,
 * 但那只是不摆在眼前 —— 地址栏里手敲 /admin/usage 一样能打开页面。
 * 接口层确实会把越权的 scope=all 静默降到 self,所以数据不会泄露,
 * 但那样用户会看到一个标题写着"全平台"、内容却只有自己的页面 ——
 * 一个说谎的界面比一个拒绝的界面更糟。这里直接挡在门外。
 *
 * 【为什么跳回工作台而不是报 403】这个人是合法登录用户,只是没有这项权限。
 * 把他扔到一个错误页,不如送回他本来该待的地方。
 */
export async function requireAdmin(): Promise<void> {
  const { env } = getContainer();
  // 本地开发关掉登录时,authorize 会发一个匿名 admin,页面同样按管理员放行
  if (!env.authRequired) return;

  const user = await currentUserFromCookies();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
}
