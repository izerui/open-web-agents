import { GET as openapi } from "@/app/api/agents/[id]/openapi.json/route";
import { GET as versionDetail } from "@/app/api/agents/[id]/versions/[version]/route";
import { openAgent } from "@/app/api/agents/_lib/agent-access";
import { GET as listAgents, POST as saveAgent } from "@/app/api/agents/route";
import { POST as rotateKey } from "@/app/api/keys/[id]/rotate/route";
import { POST as issueKey } from "@/app/api/keys/route";
import { GET as detailMarket, PATCH as patchMarket } from "@/app/api/market/[id]/route";
import { GET as listMarket } from "@/app/api/market/route";
import { POST as createSession } from "@/app/api/sessions/route";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, publishedAgent } from "./fixture";

let container: Awaited<ReturnType<typeof fixture>>;
vi.mock("@/lib/container", () => ({ getContainer: () => container }));
vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn(async () => {}),
  },
}));

function request(path: string, user = "customer", body?: unknown, key?: string) {
  return new Request(`http://test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(user ? { "x-test-user": user } : {}),
      ...(key ? { "X-Api-Key": key } : {}),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const context = () => ({ params: Promise.resolve({ id: publishedAgent.id }) });

async function setListing(listed = true, user = "admin") {
  return patchMarket(
    request("/api/market/market-agent", user, { listed, category: "research" }),
    context(),
  );
}

beforeEach(async () => {
  container = await fixture();
});

describe("market HTTP integration (memory repositories)", () => {
  it("requires login, restricts management to admins, and lists only published candidates", async () => {
    expect((await listMarket(request("/api/market", ""))).status).toBe(401);
    expect((await setListing(true, "owner")).status).toBe(403);
    expect((await listMarket(request("/api/market?manage=true"))).status).toBe(403);
    const candidates = await listMarket(request("/api/market?manage=true", "admin"));
    expect(candidates.status).toBe(200);
    expect((await candidates.json()).items).toHaveLength(1);
    expect((await setListing()).status).toBe(200);
    expect(container.audit.record).toHaveBeenCalledTimes(1);
    const listed = await listMarket(request("/api/market?category=research&q=Published"));
    expect((await listed.json()).items).toHaveLength(1);
    expect((await listMarket(request("/api/market?category=unknown"))).status).toBe(400);
  });

  it("market and ordinary use-only listing expose no draft, prompt, skill source or MCP", async () => {
    await setListing();
    for (const response of [
      await listMarket(request("/api/market")),
      await detailMarket(request("/api/market/market-agent"), context()),
      await listAgents(request("/api/agents")),
    ]) {
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(JSON.stringify(body)).not.toMatch(/private-|secret|Draft/);
      expect(JSON.stringify(body)).toContain("Public starter");
      expect(JSON.stringify(body)).not.toMatch(
        /systemPrompt|skillPackages|mcpServers|escapeHatch|ownerId/,
      );
    }
    const opened = await openAgent(request("/api/agents/market-agent"), publishedAgent.id, "read");
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.res.status).toBe(404);
    expect(
      (
        await versionDetail(request("/api/agents/market-agent/versions/1"), {
          params: Promise.resolve({ id: publishedAgent.id, version: "1" }),
        })
      ).status,
    ).toBe(404);
    const contract = await openapi(request("/api/agents/market-agent/openapi.json"), context());
    expect(contract.status).toBe(200);
    expect(JSON.stringify(await contract.json())).not.toMatch(/private-|secret/);
  });

  it("creates published sessions for customers AND owners; unlisting blocks new customer sessions", async () => {
    await setListing();
    for (const user of ["customer", "owner", "admin"]) {
      const response = await createSession(
        request("/api/sessions", user, { agentId: publishedAgent.id, versionMode: "published" }),
      );
      expect(response.status).toBe(201);
      expect((await response.json()).session).toMatchObject({
        agentId: publishedAgent.id,
        agentVersion: 1,
        ownerId: user,
        source: "web",
      });
    }
    const history = await container.sessions.list();
    await setListing(false);
    expect(
      (await createSession(request("/api/sessions", "customer", { agentId: publishedAgent.id })))
        .status,
    ).toBe(403);
    expect(await container.sessions.list()).toEqual(history);
    expect((await detailMarket(request("/api/market/market-agent"), context())).status).toBe(404);
  });

  it("preserves writer draft trials while market usage explicitly pins the released version", async () => {
    await setListing();
    for (const versionMode of [undefined, "draft"]) {
      const response = await createSession(
        request("/api/sessions", "owner", {
          agentId: publishedAgent.id,
          versionMode,
        }),
      );
      expect(response.status).toBe(201);
      const session = (await response.json()).session;
      expect(session.agentVersion).toBeUndefined();
      const agent = await container.agents.get(publishedAgent.id);
      if (!agent) throw new Error("missing agent");
      expect((await container.releases.at(agent, session.agentVersion)).config.systemPrompt).toBe(
        "unpublished-secret",
      );
    }
    const ordinary = await createSession(
      request("/api/sessions", "customer", { agentId: publishedAgent.id }),
    );
    expect(ordinary.status).toBe(201);
    expect((await ordinary.json()).session.agentVersion).toBe(1);
  });

  it("denies draft mode to use-only/read-only callers and owner API keys", async () => {
    await setListing();
    const before = await container.sessions.list();
    const payload = { agentId: publishedAgent.id, versionMode: "draft" };
    expect((await createSession(request("/api/sessions", "customer", payload))).status).toBe(403);
    await container.grants.grant({
      id: "read",
      resourceId: publishedAgent.id,
      resourceType: "agent",
      principalType: "user",
      principalId: "customer",
      permission: "read",
    });
    expect((await createSession(request("/api/sessions", "customer", payload))).status).toBe(403);
    const issued = await issueKey(request("/api/keys", "owner", { agentId: publishedAgent.id }));
    const key = (await issued.json()).plaintext;
    expect((await createSession(request("/api/sessions", "", payload, key))).status).toBe(403);
    expect(await container.sessions.list()).toEqual(before);
    const apiSession = await createSession(
      request("/api/sessions", "", { agentId: publishedAgent.id }, key),
    );
    expect(apiSession.status).toBe(201);
    expect((await apiSession.json()).session.agentVersion).toBe(1);
  });

  it("rejects unknown modes and explicit published mode on unpublished agents", async () => {
    expect(
      (
        await createSession(
          request("/api/sessions", "owner", {
            agentId: publishedAgent.id,
            versionMode: "latest",
          }),
        )
      ).status,
    ).toBe(400);
    await container.agents.upsert({ ...publishedAgent, id: "unpublished" });
    const response = await createSession(
      request("/api/sessions", "owner", {
        agentId: "unpublished",
        versionMode: "published",
      }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("not_published");
    expect(await container.sessions.list()).toEqual([]);
  });

  it("allows bound integration Key issuance/rotation without granting definition access", async () => {
    await setListing();
    const response = await issueKey(
      request("/api/keys", "customer", { agentId: publishedAgent.id, name: "Market" }),
    );
    expect(response.status).toBe(201);
    const issued = await response.json();
    const principal = await container.auth.requireApiKey(
      request("/", "", undefined, issued.plaintext),
    );
    await container.auth.assertCanInvoke(principal, publishedAgent.id);
    const byKey = await listAgents(request("/api/agents", "", undefined, issued.plaintext));
    expect((await byKey.json()).agents).toHaveLength(1);
    const manage = await patchMarket(
      request(
        "/api/market/market-agent",
        "",
        { listed: false, category: "research" },
        issued.plaintext,
      ),
      context(),
    );
    expect(manage.status).toBe(403);
    const rotated = await rotateKey(request("/api/keys/rotate", "customer", {}), {
      params: Promise.resolve({ id: issued.key.id }),
    });
    expect(rotated.status).toBe(201);
    await setListing(false);
    await expect(
      container.auth.assertCanInvoke(principal, publishedAgent.id),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await issueKey(request("/api/keys", "customer", { agentId: publishedAgent.id }))).status,
    ).toBe(404);
    expect(
      (
        await rotateKey(request("/api/keys/rotate", "customer", {}), {
          params: Promise.resolve({ id: issued.key.id }),
        })
      ).status,
    ).toBe(403);
  });

  it("retains legacy read sharing on unlist and prevents normal save from editing market flags", async () => {
    const grant = await container.grants.grant({
      id: "public",
      resourceId: publishedAgent.id,
      resourceType: "agent",
      principalType: "*",
      principalId: "*",
      permission: "read",
    });
    await setListing();
    const before = await listAgents(request("/api/agents"));
    expect((await before.json()).agents[0].config.systemPrompt).toBe(
      publishedAgent.config.systemPrompt,
    );
    const saved = await saveAgent(
      request("/api/agents", "owner", {
        id: publishedAgent.id,
        name: "Owner changed draft",
        config: { systemPrompt: "Changed", model: "sonnet" },
        marketListed: false,
        marketCategory: "content",
      }),
    );
    expect(saved.status).toBe(201);
    expect(await container.agents.get(publishedAgent.id)).toMatchObject({
      marketListed: true,
      marketCategory: "research",
    });
    await setListing(false);
    expect(await container.grants.listForType("agent")).toEqual([grant]);
    await container.auth.assertCanInvoke({ type: "web", userId: "customer" }, publishedAgent.id);
    expect((await openAgent(request("/"), publishedAgent.id, "read")).ok).toBe(true);
  });
});
