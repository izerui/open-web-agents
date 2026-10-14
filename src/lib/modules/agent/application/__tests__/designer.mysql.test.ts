import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { agents as agentsTable, sessions as sessionsTable } from "@/lib/db/schema";
import { designTransaction } from "@/lib/design-transaction";
import type { StoragePort } from "@/lib/modules/artifacts/ports";
import { MysqlSessionRepo } from "@/lib/modules/session/adapters/mysql-session-repo";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MysqlAgentRepo } from "../../adapters/mysql-agent-repo";
import { draftOf } from "../../domain/design";
import { contentHash, snapshotOf } from "../../domain/release";
import { DESIGN_EXECUTOR_ID } from "../../domain/system-agent";
import type { Agent } from "../../ports";
import { AgentDesigner, type DesignerDeps } from "../designer";

const url = process.env.OWA_TEST_DATABASE_URL;
if (url && new URL(url).pathname !== "/owa_test") {
  throw new Error("Designer transaction tests require the dedicated owa_test database");
}

// No truncate: only records created by this file are removed.
describe.skipIf(!url)("AgentDesigner MySQL transactions", () => {
  const connection = url ? createDb(url) : undefined;
  const agentIds = new Set<string>();
  const sessionIds = new Set<string>();
  const owner = { userId: `designer-${randomUUID().slice(0, 8)}` };
  const storage: StoragePort = {
    tree: vi.fn(async () => []),
    preview: vi.fn(),
    read: vi.fn(),
    write: vi.fn(async () => {}),
  };
  const id = () => randomUUID().replaceAll("-", "").slice(0, 24);
  const repos = () => {
    if (!connection) throw new Error("test database not configured");
    return {
      agents: new MysqlAgentRepo(connection.db),
      sessions: new MysqlSessionRepo(connection.db),
      inSession: designTransaction(connection.db),
    };
  };
  const service = (inSession = repos().inSession) =>
    new AgentDesigner({ inSession, storage, allowStdioMcp: false });
  const createTarget = async () => {
    const agentId = id();
    agentIds.add(agentId);
    return repos().agents.upsert({
      id: agentId,
      ownerId: owner.userId,
      name: "Original",
      webhookUrl: "https://hooks.example.test/original",
      config: { model: "sonnet", systemPrompt: "Original prompt" },
    });
  };
  const createSession = async (target?: Agent) => {
    const sessionId = id();
    sessionIds.add(sessionId);
    return repos().sessions.create({
      id: sessionId,
      agentId: DESIGN_EXECUTOR_ID,
      ownerId: owner.userId,
      source: "design",
      workspaceDir: `/unused-designer-test/${sessionId}`,
      designTargetAgentId: target?.id,
      designState: {
        baseHash: target ? contentHash(snapshotOf(target)) : null,
        resourceAgentIds: target ? [target.id] : [],
        draft: { ...draftOf(target), name: "Designed", systemPrompt: "Designed prompt" },
      },
    });
  };
  const preview = async (sessionId: string) => {
    const view = await service().inspect(owner, sessionId);
    if (view.legacy) throw new Error("expected initialized design");
    expect(view.issues).toEqual([]);
    return view;
  };

  afterAll(async () => {
    if (!connection) return;
    try {
      for (const sessionId of sessionIds) {
        await connection.db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId));
      }
      for (const agentId of agentIds) {
        await connection.db.delete(agentsTable).where(eq(agentsTable.id, agentId));
      }
    } finally {
      await connection.pool.end();
    }
  });

  it.each(["new", "existing"] as const)(
    "rolls back both %s target save and session linkage on failure before commit",
    async (kind) => {
      const target = kind === "existing" ? await createTarget() : undefined;
      const session = await createSession(target);
      const view = await preview(session.id);
      const before = await repos().sessions.get(session.id);
      let savedId: string | undefined;
      const real = repos().inSession;
      const failBeforeCommit: DesignerDeps["inSession"] = (sessionId, fn) =>
        real(sessionId, async (tx) => {
          const upsert = tx.agents.upsert.bind(tx.agents);
          vi.spyOn(tx.agents, "upsert").mockImplementation(async (agent) => {
            const saved = await upsert(agent);
            savedId = saved.id;
            agentIds.add(saved.id);
            return saved;
          });
          await fn(tx);
          const changed = await tx.sessions.get(sessionId);
          expect(changed?.designTargetAgentId).toBe(savedId);
          throw new Error("injected failure before commit");
        });
      await expect(
        service(failBeforeCommit).apply(owner, session.id, view.previewToken),
      ).rejects.toThrow("injected failure before commit");
      expect(savedId).toBeTruthy();
      if (!savedId) throw new Error("save was not reached");
      expect(await repos().sessions.get(session.id)).toEqual(before);
      expect(await repos().agents.get(savedId)).toEqual(target ?? null);
      const retry = await service().apply(owner, session.id, view.previewToken);
      agentIds.add(retry.agent.id);
      expect(retry.created).toBe(kind === "new");
      expect((await preview(session.id)).conflict).toBe(false);
    },
  );

  it("serializes two applies to a new design so they cannot create two agents", async () => {
    const session = await createSession();
    const view = await preview(session.id);
    const results = await Promise.allSettled([
      service().apply(owner, session.id, view.previewToken),
      service().apply(owner, session.id, view.previewToken),
    ]);
    for (const result of results) {
      if (result.status === "fulfilled") agentIds.add(result.value.agent.id);
    }
    const winners = results.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "preview_changed" },
    });
    const saved = winners[0];
    if (saved?.status !== "fulfilled") throw new Error("missing successful apply");
    expect((await repos().sessions.get(session.id))?.designTargetAgentId).toBe(
      saved.value.agent.id,
    );
    expect((await preview(session.id)).conflict).toBe(false);
  });

  it("serializes different design sessions applying to the same target", async () => {
    const target = await createTarget();
    const a = await createSession(target);
    const b = await createSession(target);
    const av = await preview(a.id);
    const bv = await preview(b.id);
    const results = await Promise.allSettled([
      service().apply(owner, a.id, av.previewToken),
      service().apply(owner, b.id, bv.previewToken),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "target_changed" },
    });
    expect((await repos().agents.get(target.id))?.config.systemPrompt).toBe("Designed prompt");
  });

  it("rereads a target changed after context lookup but before taking its row lock", async () => {
    const target = await createTarget();
    const session = await createSession(target);
    const view = await preview(session.id);
    const gate = () => {
      let open = () => {};
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, wait };
    };
    const reached = gate();
    const release = gate();
    const real = repos().inSession;
    const pauseBeforeTargetLock: DesignerDeps["inSession"] = (sessionId, fn) =>
      real(sessionId, async (tx) => {
        const lock = tx.agents.lockRow.bind(tx.agents);
        vi.spyOn(tx.agents, "lockRow").mockImplementation(async (agentId) => {
          reached.open();
          await release.wait;
          await lock(agentId);
        });
        return fn(tx);
      });
    // Attach rejection handling immediately; always release the gate before assertions can escape.
    const applying = service(pauseBeforeTargetLock)
      .apply(owner, session.id, view.previewToken)
      .then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
    try {
      await Promise.race([
        reached.wait,
        applying.then(() => {
          throw new Error("apply ended before reaching target lock");
        }),
      ]);
      await repos().agents.upsert({
        ...target,
        config: { ...target.config, systemPrompt: "Manual edit" },
      });
    } finally {
      release.open();
    }
    expect((await applying).error).toMatchObject({ code: "target_changed" });
    expect((await repos().agents.get(target.id))?.config.systemPrompt).toBe("Manual edit");
    expect((await repos().sessions.get(session.id))?.designState).toEqual(session.designState);
  });
});
