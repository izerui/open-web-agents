import { getContainer } from "@/lib/container";
import { authErrorResponse } from "@/lib/modules/access/application/authorize";
import { AgentMarket, MarketError } from "@/lib/modules/market/application/catalog";
import { ListingRequests } from "@/lib/modules/market/application/listing-requests";

/** 上架申请(A13):批准时复用 market.setListing 的同一套上架校验 */
export function listingRequestsOf(
  container: ReturnType<typeof getContainer>,
  market?: AgentMarket,
) {
  return new ListingRequests({
    repo: container.listingRequests,
    releases: container.releases,
    market: market ?? new AgentMarket(container.agents, container.releases),
  });
}

export async function marketContext(req: Request) {
  const container = getContainer();
  const principal = await container.auth.resolveWeb(req);
  const market = new AgentMarket(container.agents, container.releases);
  return {
    ...container,
    principal,
    subject: await container.auth.subjectOf(principal),
    market,
    requests: listingRequestsOf(container, market),
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
