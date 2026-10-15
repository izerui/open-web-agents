import { Forbidden } from "@/lib/modules/access/application/authorize";
import { InMemoryCapabilityRepo } from "@/lib/modules/capabilities/adapters/in-memory-capability-repo";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ admin: false, apiKey: false }));
let repo = new InMemoryCapabilityRepo();
vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    capabilities: repo,
    env: {
      models: { base: "actual-model" },
      defaultApiKey: "private-provider-key",
      defaultBaseUrl: "https://private-gateway",
    },
    audit: { record: vi.fn(async () => {}) },
    auth: {
      resolveWeb: async () =>
        state.apiKey ? { type: "apiKey", ownerId: "admin" } : { type: "web", userId: "user" },
      subjectOf: async () => ({ userId: "user" }),
      assertCanAdministerPlatform: () => {
        if (!state.admin || state.apiKey) throw new Forbidden("admin only");
      },
    },
  }),
}));
import { GET, POST } from "../route";

const definition = {
  id: "main-model",
  name: "主力模型",
  modelId: "actual-model",
  kind: "llm",
  enabled: true,
  acceptsImages: true,
  rates: [{ meter: "input_token", units: "1000", microCredits: "123000" }],
};
const post = (body: unknown) =>
  POST(
    new Request("http://local/api/capabilities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("capability API", () => {
  beforeEach(() => {
    repo = new InMemoryCapabilityRepo();
    state.admin = false;
    state.apiKey = false;
  });
  it("only administrators can update prices; their integration API key cannot administer", async () => {
    expect((await post({ definition, expectedVersion: null })).status).toBe(403);
    state.admin = true;
    state.apiKey = true;
    expect((await post({ definition, expectedVersion: null })).status).toBe(403);
    state.apiKey = false;
    expect((await post({ definition, expectedVersion: null })).status).toBe(201);
  });
  it("does not expose provider credentials or actual routing model to ordinary readers", async () => {
    await repo.save(definition as Parameters<typeof repo.save>[0], null, "admin");
    const response = await GET(new Request("http://local/api/capabilities"));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("123000");
    expect(text).not.toContain("actual-model");
    expect(text).not.toContain("private-provider-key");
    expect(text).not.toContain("private-gateway");
    expect(JSON.parse(text).capabilities[0].available).toBe(true);
    expect((await GET(new Request("http://local/api/capabilities?manage=1"))).status).toBe(403);
  });
  it("cannot silently overwrite a newer price and refuses unknown units", async () => {
    state.admin = true;
    expect((await post({ definition, expectedVersion: null })).status).toBe(201);
    expect((await post({ definition, expectedVersion: null })).status).toBe(409);
    expect(
      (
        await post({
          definition: {
            ...definition,
            rates: [{ meter: "video_ms", units: "1", microCredits: "1" }],
          },
          expectedVersion: 1,
        })
      ).status,
    ).toBe(400);
  });
  it("media models are not marked callable before provider integration exists", async () => {
    await repo.save(
      {
        ...definition,
        kind: "image",
        acceptsImages: false,
        rates: [{ meter: "image", units: "1", microCredits: "1" }],
      },
      null,
      "admin",
    );
    const response = await GET(new Request("http://local/api/capabilities"));
    expect((await response.json()).capabilities[0].available).toBe(false);
  });
});
