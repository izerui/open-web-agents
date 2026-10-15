import { randomUUID } from "node:crypto";
import { InMemoryBillingRepo } from "../in-memory-billing-repo";
import { billingContract } from "./billing.contract";

billingContract("InMemoryBillingRepo", (options) => {
  const accountId = `billing-${randomUUID().slice(0, 24)}`;
  return {
    repo: new InMemoryBillingRepo(options),
    accountId,
    otherAccountId: accountId.toUpperCase(),
  };
});
