import { getContainer } from "@/lib/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 保留旧入口给出明确迁移提示;不读取请求正文或历史模型密钥。 */
export async function PUT(req: Request) {
  const { authService } = getContainer();

  const user = await authService.currentUser(req);
  if (!user) return Response.json({ error: "login required" }, { status: 401 });

  return Response.json(
    {
      code: "byok_disabled",
      error: "模型算力统一由平台提供，不再支持自带模型 API Key 或自定义网关。",
    },
    { status: 410 },
  );
}
