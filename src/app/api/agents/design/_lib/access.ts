import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { DesignError } from "@/lib/modules/agent/application/designer";

export async function designCaller(req: Request) {
  const { auth } = getContainer();
  const principal = await auth.resolveWeb(req);
  auth.assertCanManageAgents(principal);
  return { principal, subject: await auth.subjectOf(principal) };
}

export function designError(err: unknown): Response {
  const auth = authErrorResponse(err);
  if (auth) return auth;
  if (err instanceof DesignError) {
    return Response.json({ error: err.message, code: err.code }, { status: err.status });
  }
  throw err;
}
