import { LoginForm } from "@/features/auth/login-form";
import { getContainer } from "@/lib/container";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const { users, env } = getContainer();
  // 关闭登录的本地开发模式下不需要这一页
  if (!env.authRequired) redirect("/");
  const firstRun = (await users.count()) === 0;
  return <LoginForm firstRun={firstRun} />;
}
