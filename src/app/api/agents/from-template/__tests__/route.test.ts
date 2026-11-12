// 按模板建草稿:内容取自代码里的模板目录,创建本身交给 POST /api/agents(同一份鉴权、校验、审计)。

import { findTemplate } from "@/lib/modules/agent/templates";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  taken: new Set<string>(),
  upserts: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  apiKey: false,
}));

vi.mock("@/lib/container", async () => {
  const { Forbidden } = await import("@/lib/modules/access/application/authorize");
  return {
    getContainer: () => ({
      auth: {
        resolveWeb: async () =>
          state.apiKey
            ? { type: "apiKey", userId: "me", agentId: "x" }
            : { type: "web", userId: "me", role: "user" },
        subjectOf: async () => ({ userId: "me", role: "user" }),
        assertCanManageAgents: (p: { type: string }) => {
          if (p.type !== "web") throw new Forbidden("api keys cannot manage agents");
        },
      },
      env: { allowStdioMcp: false, webhookAllowPrivate: false },
      grants: { listForResource: async () => [] },
      agents: {
        get: async () => null,
        idTaken: async (id: string) => state.taken.has(id),
        upsert: async (a: Record<string, unknown>) => {
          state.upserts.push(a);
          return a;
        },
      },
      audit: {
        record: async (e: Record<string, unknown>) => {
          state.audits.push(e);
        },
      },
      modelCatalogView: async () => undefined,
    }),
  };
});

beforeEach(() => {
  state.taken = new Set();
  state.upserts = [];
  state.audits = [];
  state.apiKey = false;
});

async function post(body: unknown) {
  const { POST } = await import("../route");
  const res = await POST(
    new Request("http://x/api/agents/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: "owa=1" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/agents/from-template", () => {
  it("用模板内容建一份草稿,可以改名", async () => {
    const t = findTemplate("contract-diff");
    const r = await post({ templateId: "contract-diff", name: "采购合同比对" });
    expect(r.status).toBe(201);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toMatchObject({
      ownerId: "me",
      name: "采购合同比对",
      description: t?.description,
      icon: t?.icon,
      config: { systemPrompt: t?.systemPrompt, model: t?.model, starters: t?.starters },
    });
    expect(state.audits[0]).toMatchObject({ action: "agent.create" });
  });

  it("指定的 ID 已被占用时 409,不覆盖", async () => {
    state.taken = new Set(["mine"]);
    const r = await post({ templateId: "sql-helper", id: "mine" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("id_taken");
    expect(state.upserts).toHaveLength(0);
  });

  it("模板不存在或没给模板 400", async () => {
    expect((await post({ templateId: "nope" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(state.upserts).toHaveLength(0);
  });

  it("API Key 不能建智能体", async () => {
    state.apiKey = true;
    expect((await post({ templateId: "sql-helper" })).status).toBe(403);
    expect(state.upserts).toHaveLength(0);
  });
});
