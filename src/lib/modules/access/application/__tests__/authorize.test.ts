// 授权器的凭证状态复查:签发人停用、Key 吊销、分享撤销之后,API Key 与嵌入令牌必须一起失效。

import { Authorizer, Forbidden, Unauthorized } from "@/lib/modules/access/application/authorize";
import type { Grant } from "@/lib/modules/access/domain/grants";
import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { generateApiKey, hashApiKey } from "@/lib/modules/identity/domain/api-key";
import type { ApiKeyRecord, ApiKeyRepo } from "@/lib/modules/identity/ports";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import { describe, expect, it } from "vitest";

function setup() {
  const plain = generateApiKey();
  const hashed = hashApiKey(plain);
  const keys = new Map<string, ApiKeyRecord>();
  keys.set("k1", { id: "k1", ownerId: "u1", createdAt: 0 });
  const apiKeys = {
    findByHash: async (h: string) => (h === hashed ? (keys.get("k1") ?? null) : null),
    get: async (id: string) => keys.get(id) ?? null,
    touch: async () => {},
  } as unknown as ApiKeyRepo;
  const disabled = new Set<string>();
  const grants: Grant[] = [];
  const auth = new Authorizer({
    apiKeys,
    sessions: new InMemorySessionRepo(),
    agents: new InMemoryAgentRepo([
      { id: "mine", ownerId: "u1", name: "m", config: { systemPrompt: "p", model: "sonnet" } },
      { id: "shared", ownerId: "u2", name: "s", config: { systemPrompt: "p", model: "sonnet" } },
    ]),
    grants: {
      listForResource: async () => grants,
    } as never,
    authRequired: true,
    currentUser: async () => null,
    isUserActive: async (id) => !disabled.has(id),
  });
  const req = () => new Request("http://x", { headers: { "X-Api-Key": plain } });
  return { auth, keys, disabled, grants, req };
}

describe("Authorizer 凭证状态复查", () => {
  it("签发人被停用:API Key 立即失效", async () => {
    const { auth, disabled, req } = setup();
    await expect(auth.requireApiKey(req())).resolves.toMatchObject({ keyId: "k1" });
    disabled.add("u1");
    await expect(auth.requireApiKey(req())).rejects.toBeInstanceOf(Unauthorized);
  });

  it("Key 到期:API Key 与由它换出的嵌入令牌一起失效;还没到期照常可用", async () => {
    const { auth, keys, req } = setup();
    const k = keys.get("k1") as ApiKeyRecord;
    keys.set("k1", { ...k, expiresAt: Date.now() + 60_000 });
    await expect(auth.requireApiKey(req())).resolves.toMatchObject({ keyId: "k1" });
    keys.set("k1", { ...k, expiresAt: Date.now() - 1 });
    await expect(auth.requireApiKey(req())).rejects.toThrow(/expired/);
    await expect(auth.resolveEmbed({ keyId: "k1", agentId: "mine" })).rejects.toBeInstanceOf(
      Unauthorized,
    );
  });

  it("嵌入令牌:签发它的 Key 被吊销后失效", async () => {
    const { auth, keys } = setup();
    await expect(auth.resolveEmbed({ keyId: "k1", agentId: "mine" })).resolves.toBeTruthy();
    keys.delete("k1");
    await expect(auth.resolveEmbed({ keyId: "k1", agentId: "mine" })).rejects.toBeInstanceOf(
      Unauthorized,
    );
  });

  it("嵌入令牌:签发人被停用后失效", async () => {
    const { auth, disabled } = setup();
    disabled.add("u1");
    await expect(auth.resolveEmbed({ keyId: "k1", agentId: "mine" })).rejects.toBeInstanceOf(
      Unauthorized,
    );
  });

  it("嵌入令牌:分享被撤销后失效", async () => {
    const { auth, grants } = setup();
    grants.push({
      id: "g1",
      resourceType: "agent",
      resourceId: "shared",
      principalType: "user",
      principalId: "u1",
      permission: "read",
    } as Grant);
    await expect(auth.resolveEmbed({ keyId: "k1", agentId: "shared" })).resolves.toBeTruthy();
    grants.length = 0;
    await expect(auth.resolveEmbed({ keyId: "k1", agentId: "shared" })).rejects.toBeInstanceOf(
      Forbidden,
    );
  });
});
