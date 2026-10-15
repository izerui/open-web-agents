import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { AgentMarket, MarketError } from "@/lib/modules/market/application/catalog";

export async function marketContext(req: Request) {
  const container = getContainer();
  const principal = await container.auth.resolveWeb(req);
  return {
    ...container,
    principal,
    subject: await container.auth.subjectOf(principal),
    market: new AgentMarket(container.agents, container.releases),
  };
}

export function marketError(error: unknown) {
  const authError = authErrorResponse(error);
  if (authError) return authError;
  if (error instanceof MarketError) {
    return Response.json({ code: error.code, error: error.message }, { status: error.status });
  }
  throw error;
}
