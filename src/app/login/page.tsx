import { LoginForm } from "@/features/auth/login-form";
import { getContainer } from "@/lib/container";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const { users, env, authService } = getContainer();

  // 关闭登录的本地开发模式下不需要这一页
  if (!env.authRequired) redirect("/");

  // 已登录的人不该再看到登录页
  const h = await headers();
  const req = new Request("http://internal/", { headers: { cookie: h.get("cookie") ?? "" } });
  if (await authService.currentUser(req)) redirect("/");

  const firstRun = (await users.count()) === 0;
  return <LoginForm firstRun={firstRun} />;
}
