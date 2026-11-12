import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { templateCreateBody } from "@/lib/modules/agent/templates";
import { POST as createAgent } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 按模板建一份草稿(A14)。body:{ templateId, name?, id? }。
 *
 * 【为什么转给 POST /api/agents 而不是自己写库】创建要过的关卡(只许网页登录、配置校验、
 * ID 占用、审计)都在那里;这里另写一份,两边迟早会对不上。模板只负责把请求体填好。
 */
export async function POST(req: Request) {
  try {
    const { auth } = getContainer();
    auth.assertCanManageAgents(await auth.resolveWeb(req));
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = (await req.json().catch(() => ({}))) as {
    templateId?: unknown;
    name?: unknown;
    id?: unknown;
  };
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const templateId = text(body.templateId);
  const create = templateId
    ? templateCreateBody(templateId, { name: text(body.name), id: text(body.id) })
    : null;
  if (!create) return Response.json({ error: "模板不存在" }, { status: 400 });

  const headers = new Headers(req.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return createAgent(
    new Request(new URL("/api/agents", req.url), {
      method: "POST",
      headers,
      body: JSON.stringify(create),
    }),
  );
}
