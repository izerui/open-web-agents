import { capabilityContract } from "../../ports.contract";
import { InMemoryCapabilityRepo } from "../in-memory-capability-repo";

capabilityContract("memory", () => new InMemoryCapabilityRepo());
