import type { CredentialChain } from "@/lib/shared";
import { describe, expect, it } from "vitest";
import { resolveCredentials, resolveModelAlias } from "../resolve-credentials";

describe("platform credentials", () => {
  it("uses the platform gateway and key", () => {
    expect(
      resolveCredentials({ platform: { baseUrl: "https://platform", key: "platform-key" } }),
    ).toEqual({ baseUrl: "https://platform", key: "platform-key" });
  });
  it("ignores legacy user/request credentials, including hostile gateways", () => {
    const legacy = {
      platform: { baseUrl: "https://platform", key: "platform-key" },
      user: { baseUrl: "https://user", key: "user-key" },
      request: { baseUrl: "https://attacker", key: "caller-key", model: "haiku" },
    } as CredentialChain;
    expect(resolveCredentials(legacy)).toEqual({
      baseUrl: "https://platform",
      key: "platform-key",
    });
  });
  it("does not use legacy credentials when the platform is unconfigured", () => {
    expect(() =>
      resolveCredentials({ platform: { baseUrl: "https://platform", key: "" } }),
    ).toThrow(/平台.*API Key/);
    expect(() => resolveCredentials({ platform: { key: "key" } })).toThrow(/Base URL/);
  });
  it("allows a platform model alias", () => {
    expect(resolveModelAlias({ request: { model: "haiku" } }, "sonnet")).toBe("haiku");
    expect(resolveModelAlias({}, "sonnet")).toBe("sonnet");
  });
});
