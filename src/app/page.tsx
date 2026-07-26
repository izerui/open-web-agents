import { Workbench } from "@/features/workbench/workbench";
import { getContainer } from "@/lib/container";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { authService, env } = getContainer();

  // 服务端就把未登录的人挡在工作台之外,避免先渲染再被 API 全线 401
  if (env.authRequired) {
    const h = await headers();
    const req = new Request("http://internal/", { headers: { cookie: h.get("cookie") ?? "" } });
    if (!(await authService.currentUser(req))) redirect("/login");
  }

  return <Workbench />;
}
