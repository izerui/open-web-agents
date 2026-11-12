import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { AGENT_TEMPLATES } from "@/lib/modules/agent/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 新建弹层的模板库(A14)。模板是代码里的静态目录,登录即可看。 */
export async function GET(req: Request) {
  try {
    await getContainer().auth.resolveWeb(req);
    return Response.json({ templates: AGENT_TEMPLATES });
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
