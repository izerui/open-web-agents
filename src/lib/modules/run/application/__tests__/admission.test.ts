import { AdmissionRejected, RunAdmission } from "@/lib/modules/run/application/admission";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import { describe, expect, it } from "vitest";

const SCHEMA = { type: "object", required: ["topic"], properties: { topic: { type: "string" } } };

class QuotaHit extends Error {}

async function setup(opts: { schema?: boolean; rateAllowed?: boolean; quotaOk?: boolean } = {}) {
  const sessions = new InMemorySessionRepo();
  await sessions.create({ id: "web", agentId: "a", workspaceDir: "/w", ownerId: "u1" });
  await sessions.create({
    id: "api",
    agentId: "a",
    workspaceDir: "/w",
    source: "api",
    callerApiKeyId: "k1",
    billingUserId: "owner",
  });
  await sessions.create({ id: "orphan", agentId: "a", workspaceDir: "/w" });
  await sessions.create({ id: "gone", agentId: "a", workspaceDir: "/w", ownerId: "u1" });
  await sessions.update("gone", { status: "deleted" });
  const calls = { rate: [] as unknown[], quota: [] as string[] };
  const admission = new RunAdmission({
    sessions,
    checkQuota: async (u) => {
      calls.quota.push(u);
      if (opts.quotaOk === false) throw new QuotaHit("超额");
    },
    checkRate: async (i) => {
      calls.rate.push(i);
      return opts.rateAllowed === false
        ? { allowed: false, scope: "key", limit: 1, retryAfterMs: 1500 }
        : { allowed: true };
    },
    inputSchemaOf: async () => (opts.schema ? SCHEMA : undefined),
    validateInput: (_s, v) =>
      typeof (v as { topic?: unknown })?.topic === "string"
        ? { ok: true }
        : { ok: false, errors: ["/topic 必填"] },
    quotaRejection: (err) =>
      err instanceof QuotaHit ? new AdmissionRejected(402, "quota_exceeded", "超额") : null,
  });
  return { admission, calls };
}

const web = { type: "web" as const, userId: "u1" };
const key = { type: "apiKey" as const, keyId: "k1", ownerId: "owner", rateLimitPerMinute: 5 };

const rejected = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AdmissionRejected) return { status: e.status, code: e.code, e };
    throw e;
  }
  throw new Error("expected rejection");
};

describe("RunAdmission", () => {
  it("已删除 / 不存在的会话:404", async () => {
    const { admission } = await setup();
    expect(
      (await rejected(admission.admit({ sessionId: "gone", caller: web, prompt: "hi" }))).status,
    ).toBe(404);
    expect(
      (await rejected(admission.admit({ sessionId: "nope", caller: web, prompt: "hi" }))).status,
    ).toBe(404);
  });

  it("计费账号一条规则:会话计费账号 → 会话归属 → 调用方", async () => {
    const { admission, calls } = await setup();
    await admission.admit({ sessionId: "api", caller: key, prompt: "x" });
    await admission.admit({ sessionId: "web", caller: web, prompt: "x" });
    await admission.admit({ sessionId: "orphan", caller: web, prompt: "x" });
    expect(calls.quota).toEqual(["owner", "u1", "u1"]);
  });

  it("API Key 调用方走限流(带上 Key 自己的上限);网页登录不限流", async () => {
    const { admission, calls } = await setup();
    await admission.admit({ sessionId: "api", caller: key, prompt: "x" });
    await admission.admit({ sessionId: "web", caller: web, prompt: "x" });
    expect(calls.rate).toEqual([{ keyId: "k1", keyLimit: 5, agentId: "a" }]);
  });

  it("限流拒绝:429 带 Retry-After,且不再查额度", async () => {
    const { admission, calls } = await setup({ rateAllowed: false });
    const r = await rejected(admission.admit({ sessionId: "api", caller: key, prompt: "x" }));
    expect(r).toMatchObject({ status: 429, code: "rate_limited" });
    expect((r.e as AdmissionRejected).headers["Retry-After"]).toBe("2");
    expect(calls.quota).toEqual([]);
  });

  it("额度拒绝:402", async () => {
    const { admission } = await setup({ quotaOk: false });
    expect(
      (await rejected(admission.admit({ sessionId: "web", caller: web, prompt: "x" }))).status,
    ).toBe(402);
  });

  it("输入不合法的请求不占限流与额度", async () => {
    const { admission, calls } = await setup();
    expect(
      (await rejected(admission.admit({ sessionId: "api", caller: key, prompt: "   " }))).code,
    ).toBe("invalid_request");
    expect(
      (
        await rejected(
          admission.admit({ sessionId: "api", caller: key, prompt: "x".repeat(200_001) }),
        )
      ).status,
    ).toBe(413);
    expect(calls.rate).toEqual([]);
    expect(calls.quota).toEqual([]);
  });

  it("API Key 会话 + 声明了 inputSchema:纯文本拒绝,不合格拒绝并给出原因,合格的序列化为 JSON", async () => {
    const { admission, calls } = await setup({ schema: true });
    expect(
      (await rejected(admission.admit({ sessionId: "api", caller: key, prompt: "随便聊聊" }))).code,
    ).toBe("input_invalid");
    const bad = await rejected(admission.admit({ sessionId: "api", caller: key, input: { x: 1 } }));
    expect(bad.code).toBe("input_invalid");
    expect((bad.e as AdmissionRejected).extra.details).toEqual(["/topic 必填"]);
    expect(calls.rate).toEqual([]); // 契约不合格同样不占限流
    const ok = await admission.admit({
      sessionId: "api",
      caller: key,
      input: { topic: "均值不等式" },
    });
    expect(ok.prompt).toBe('{"topic":"均值不等式"}');
  });

  it("网页会话不套接口契约:自然语言照常受理", async () => {
    const { admission } = await setup({ schema: true });
    const ok = await admission.admit({ sessionId: "web", caller: web, prompt: "  帮我推导一下 " });
    expect(ok.prompt).toBe("帮我推导一下");
  });
});
