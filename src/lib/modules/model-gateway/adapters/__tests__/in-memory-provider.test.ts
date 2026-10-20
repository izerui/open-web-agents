import { providerContract } from "../../ports.contract";
import { InMemoryModelAliasRepo, InMemoryProviderRepo } from "../in-memory-provider-repo";

providerContract("in-memory", () => ({
  providers: new InMemoryProviderRepo(),
  aliases: new InMemoryModelAliasRepo(),
}));
