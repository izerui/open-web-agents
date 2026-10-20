import { Forbidden } from "@/lib/modules/access/application/authorize";
import { InMemoryCapabilityRepo } from "@/lib/modules/capabilities/adapters/in-memory-capability-repo";
import {
  InMemoryModelAliasRepo,
  InMemoryProviderRepo,
} from "@/lib/modules/model-gateway/adapters/in-memory-provider-repo";
import { ModelAdmin } from "@/lib/modules/model-gateway/application/model-admin";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ admin: true, apiKey: false }));
const audit = { record: vi.fn(async (_e: unknown) => {}) };
const probe = {
  testAnthropic: vi.fn(async () => ({
    ok: false,
    status: 401,
    latencyMs: 3,
    message: "invalid x-api-key: ***",
  })),
};
let modelAdmin: ModelAdmin;

vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    modelAdmin,
    audit,
    auth: {
      resolveWeb: async () =>
        state.apiKey ? { type: "apiKey", ownerId: "admin" } : { type: "web", userId: "admin" },
      assertCanAdministerPlatform: () => {
        if (!state.admin || state.apiKey) throw new Forbidden("admin only");
      },
      subjectOf: async () => ({ userId: "admin" }),
    },
  }),
}));

import { PUT as putKey } from "../[id]/key/route";
import { PATCH } from "../[id]/route";
import { POST as test } from "../[id]/test/route";
import { GET, POST } from "../route";

const SECRET = "sk-very-secret-key-0042";
const json = (method: string, body: unknown) =>
  new Request("http://local/api/admin/providers", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("管理接口:模型提供者", () => {
  beforeEach(() => {
    state.admin = true;
    state.apiKey = false;
    audit.record.mockClear();
    modelAdmin = new ModelAdmin({
      ensureModels: async () => {},
      capabilities: new InMemoryCapabilityRepo(),
      providers: new InMemoryProviderRepo(),
      aliases: new InMemoryModelAliasRepo(),
      agentRefs: { list: async () => [] },
      probe,
      encrypt: (p) => `enc:${p}`,
      decrypt: (s) => (s.startsWith("enc:") ? s.slice(4) : null),
      mask: (p) => `****${p.slice(-4)}`,
    });
  });

  it("非管理员与管理员的 API Key 都不能维护提供者", async () => {
    state.admin = false;
    expect((await GET(new Request("http://local"))).status).toBe(403);
    state.admin = true;
    state.apiKey = true;
    expect((await POST(json("POST", { definition: { name: "A", enabled: true } }))).status).toBe(
      403,
    );
  });

  it("Key 不出现在任何响应与审计里;替换只回掩码", async () => {
    const created = await POST(
      json("POST", {
        definition: {
          name: "厂商",
          enabled: true,
          endpoints: { llm: { protocol: "anthropic", baseUrl: "https://gw.example" } },
        },
        apiKey: SECRET,
      }),
    );
    expect(created.status).toBe(201);
    const createdText = await created.text();
    const id = JSON.parse(createdText).provider.id as string;
    const replaced = await putKey(json("PUT", { apiKey: `${SECRET}-new` }), params(id));
    const listed = await GET(new Request("http://local"));
    const tested = await test(json("POST", { modelId: "m-1" }), params(id));
    const everything = [
      createdText,
      await replaced.text(),
      await listed.text(),
      await tested.text(),
      JSON.stringify(audit.record.mock.calls),
    ].join("\n");
    expect(everything).not.toContain("very-secret");
    expect(JSON.parse(everything.split("\n")[1] ?? "{}")).toEqual({ keyHint: "****-new" });
    const actions = audit.record.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toEqual(["provider.create", "provider.key_replace", "provider.test"]);
  });

  it("名称重复与版本冲突返回 409;请求体不合法 400;不存在 404", async () => {
    const a = await (await POST(json("POST", { definition: { name: "A", enabled: true } }))).json();
    expect((await POST(json("POST", { definition: { name: "A", enabled: true } }))).status).toBe(
      409,
    );
    const id = a.provider.id as string;
    expect(
      (
        await PATCH(
          json("PATCH", { definition: { name: "A2", enabled: true }, expectedVersion: 1 }),
          params(id),
        )
      ).status,
    ).toBe(200);
    const stale = await PATCH(
      json("PATCH", { definition: { name: "A3", enabled: true }, expectedVersion: 1 }),
      params(id),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("conflict");
    expect(
      (await POST(new Request("http://local", { method: "POST", body: "not json" }))).status,
    ).toBe(400);
    expect((await putKey(json("PUT", { apiKey: "sk-x" }), params("missing"))).status).toBe(404);
  });
});
