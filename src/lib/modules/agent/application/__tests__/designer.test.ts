import type { Grant, Subject } from "@/lib/modules/access/domain/grants";
import type { GrantRepo } from "@/lib/modules/access/ports";
import type { StoragePort } from "@/lib/modules/artifacts/ports";
import { InMemoryRunRepo } from "@/lib/modules/run/adapters/in-memory-run-repo";
import { InMemorySessionRepo } from "@/lib/modules/session/adapters/in-memory-session-repo";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAgentRepo } from "../../adapters/in-memory-agent-repo";
import { InMemoryAgentVersionRepo } from "../../adapters/in-memory-agent-version-repo";
import { DRAFT_FILE, type DesignDraft, draftOf, resourceRef } from "../../domain/design";
import { contentHash, snapshotOf } from "../../domain/release";
import { DESIGN_EXECUTOR_ID } from "../../domain/system-agent";
import type { Agent } from "../../ports";
import { AgentDesigner, type DesignTx, type DesignerDeps } from "../designer";
import { AgentReleases } from "../releases";

const owner: Subject = { userId: "owner" };
const target: Agent = {
  id: "target",
  ownerId: owner.userId,
  name: "Original",
  icon: "icon",
  webhookUrl: "https://hooks.example.test/result",
  config: { systemPrompt: "Original prompt", model: "sonnet", escapeHatch: { custom: true } },
};
const source: Agent = {
  id: "source",
  ownerId: owner.userId,
  name: "Resources",
  config: {
    systemPrompt: "Resources",
    model: "sonnet",
    skillPackages: [
      {
        name: "report",
        description: "Existing skill",
        files: { "SKILL.md": "# Report", "scripts/report.sh": "private-script" },
      },
    ],
    mcpServers: [
      {
        name: "search",
        type: "http",
        url: "https://example.test/mcp?token=secret-token",
        env: { KEY: "secret-env" },
      },
    ],
  },
};
const validDraft = (): DesignDraft => ({
  ...draftOf(),
  name: "New agent",
  systemPrompt: "New prompt",
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test fixture");
  return value;
}

async function setup(opts: { target?: Agent; legacy?: boolean } = {}) {
  const agents = new InMemoryAgentRepo([source, ...(opts.target ? [opts.target] : [])]);
  const sessions = new InMemorySessionRepo();
  const runs = new InMemoryRunRepo();
  let grantsList: Grant[] = [];
  const grants: GrantRepo = {
    listForResource: async (_, id) => grantsList.filter((g) => g.resourceId === id),
    listForType: async () => grantsList,
    grant: async (g) => {
      grantsList.push(g);
      return g;
    },
    revoke: async (id) => {
      grantsList = grantsList.filter((g) => g.id !== id);
    },
    revokeAllForResource: async (_, id) => {
      grantsList = grantsList.filter((g) => g.resourceId !== id);
    },
  };
  const files = new Map<string, Buffer>();
  const storage: StoragePort = {
    tree: vi.fn(async () => []),
    preview: vi.fn(),
    read: vi.fn(async (_, path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error("ENOENT");
      return { bytes, mime: "application/json" };
    }),
    write: vi.fn(async (_, path, bytes) => {
      files.set(path, bytes);
    }),
  };
  const busy = vi.fn(async () => false);
  const enqueue = vi.fn<DesignTx["enqueue"]>(async () => {});
  const inSession: DesignerDeps["inSession"] = (id, fn) =>
    sessions.withWorkspaceLock(id, () => fn({ agents, sessions, grants, runs, busy, enqueue }));
  const designer = new AgentDesigner({ inSession, storage, allowStdioMcp: false });
  await sessions.create({
    id: "design",
    agentId: DESIGN_EXECUTOR_ID,
    ownerId: owner.userId,
    source: "design",
    workspaceDir: "/design-test",
    designTargetAgentId: opts.target?.id,
    designState: opts.legacy
      ? undefined
      : {
          baseHash: opts.target ? contentHash(snapshotOf(opts.target)) : null,
          resourceAgentIds: opts.target ? [opts.target.id] : [],
          draft: opts.target ? draftOf(opts.target) : validDraft(),
        },
  });
  const inspect = async () => {
    const view = await designer.inspect(owner, "design");
    if (view.legacy) throw new Error("expected initialized design");
    return view;
  };
  const edit = async (draft: DesignDraft, resourceAgentIds?: string[]) => {
    const view = await inspect();
    return designer.update(owner, "design", { revision: view.revision, draft, resourceAgentIds });
  };
  return { agents, sessions, runs, grants, storage, files, busy, enqueue, designer, inspect, edit };
}

describe("AgentDesigner", () => {
  it("creates once, associates the design with its target and edits the same agent", async () => {
    const h = await setup();
    const first = await h.designer.apply(owner, "design", (await h.inspect()).previewToken);
    expect(first).toMatchObject({
      created: true,
      saved: { ownerId: owner.userId, name: "New agent" },
    });
    expect((await h.sessions.get("design"))?.designTargetAgentId).toBe(first.agent.id);
    expect((await h.inspect()).conflict).toBe(false);
    await h.edit({ ...(await h.inspect()).draft, systemPrompt: "Edited prompt" });
    const second = await h.designer.apply(owner, "design", (await h.inspect()).previewToken);
    expect(second).toMatchObject({ created: false, agent: first.agent });
    expect((await h.agents.get(first.agent.id))?.config.systemPrompt).toBe("Edited prompt");
    expect(await h.agents.list()).toHaveLength(2);
  });

  it("preserves ownership, webhook, icon, escape hatch and the released snapshot", async () => {
    const h = await setup({ target });
    const versions = new InMemoryAgentVersionRepo(h.agents);
    const releases = new AgentReleases(h.agents, versions);
    const published = await releases.publish(target, owner.userId);
    await h.edit({ ...draftOf(target), systemPrompt: "Unpublished edit" });
    const result = await h.designer.apply(owner, "design", (await h.inspect()).previewToken);
    expect(result.saved).toMatchObject({
      ownerId: target.ownerId,
      icon: target.icon,
      webhookUrl: target.webhookUrl,
      publishedVersion: 1,
      publishedHash: published.contentHash,
      config: { systemPrompt: "Unpublished edit", escapeHatch: target.config.escapeHatch },
    });
    expect(await releases.resolve(result.saved)).toMatchObject({
      version: 1,
      config: { systemPrompt: target.config.systemPrompt },
    });
    expect(await versions.get(target.id, 1)).toEqual(published);
  });

  it("requires reset for legacy sessions and reloads the current target", async () => {
    const h = await setup({ target, legacy: true });
    expect(await h.designer.inspect(owner, "design")).toMatchObject({ legacy: true });
    await expect(h.designer.apply(owner, "design", "token")).rejects.toMatchObject({
      code: "design_legacy",
    });
    await expect(h.designer.update(owner, "design", { draft: validDraft() })).rejects.toMatchObject(
      { code: "design_legacy" },
    );
    await expect(h.designer.enqueue(owner, "design", "run", "edit")).rejects.toMatchObject({
      code: "design_legacy",
    });
    await h.agents.upsert({ ...target, name: "Current" });
    expect(await h.designer.update(owner, "design", { reset: true })).toMatchObject({
      legacy: false,
      conflict: false,
      draft: { name: "Current" },
    });
  });

  it("rejects foreign, missing, deleted, ordinary and wrong-executor sessions", async () => {
    const h = await setup();
    for (const subject of [{ userId: "other" }, { userId: "admin", role: "admin" as const }]) {
      await expect(h.designer.inspect(subject, "design")).rejects.toMatchObject({ status: 404 });
      await expect(h.designer.update(subject, "design", { reset: true })).rejects.toMatchObject({
        status: 404,
      });
      await expect(h.designer.apply(subject, "design", "token")).rejects.toMatchObject({
        status: 404,
      });
      await expect(h.designer.enqueue(subject, "design", "run", "edit")).rejects.toMatchObject({
        status: 404,
      });
    }
    await expect(h.designer.inspect(owner, "missing")).rejects.toMatchObject({ status: 404 });
    for (const input of [
      { id: "ordinary", source: "web" as const, agentId: DESIGN_EXECUTOR_ID },
      { id: "wrong", source: "design" as const, agentId: "normal-agent" },
    ]) {
      await h.sessions.create({ ...input, ownerId: owner.userId, workspaceDir: "/unused" });
      await expect(h.designer.apply(owner, input.id, "token")).rejects.toMatchObject({
        status: 404,
      });
    }
    await h.sessions.update("design", { status: "deleted" });
    await expect(h.designer.inspect(owner, "design")).rejects.toMatchObject({ status: 404 });
  });

  it("rechecks target write access on every operation", async () => {
    const h = await setup({ target });
    const view = await h.inspect();
    await h.agents.upsert({ ...target, ownerId: "other" });
    await expect(h.designer.inspect(owner, "design")).rejects.toMatchObject({ status: 403 });
    await expect(
      h.designer.update(owner, "design", {
        revision: view.revision,
        reset: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(h.designer.apply(owner, "design", view.previewToken)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      h.designer.enqueue(owner, "design", "run", "edit", view.revision),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("requires current revision for edits, resets and enqueue; requires current preview for apply", async () => {
    const h = await setup();
    const old = await h.inspect();
    await h.edit({ ...old.draft, name: "Changed" });
    for (const revision of [undefined, old.revision]) {
      await expect(
        h.designer.update(owner, "design", {
          revision,
          reset: true,
        }),
      ).rejects.toMatchObject({ code: "design_changed" });
      await expect(
        h.designer.enqueue(owner, "design", "run", "edit", revision),
      ).rejects.toMatchObject({ code: "design_changed" });
    }
    for (const token of [undefined, old.previewToken]) {
      await expect(h.designer.apply(owner, "design", token)).rejects.toMatchObject({
        code: "preview_changed",
      });
    }
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(await h.agents.list()).toHaveLength(1);
  });

  it("detects target edits and can reset without overwriting the other editor", async () => {
    const h = await setup({ target });
    const old = await h.inspect();
    await h.agents.upsert({ ...target, name: "Other editor" });
    expect((await h.inspect()).conflict).toBe(true);
    await expect(h.designer.apply(owner, "design", old.previewToken)).rejects.toMatchObject({
      code: "target_changed",
    });
    expect((await h.agents.get(target.id))?.name).toBe("Other editor");
    expect(
      await h.designer.update(owner, "design", { revision: old.revision, reset: true }),
    ).toMatchObject({
      conflict: false,
      draft: { name: "Other editor" },
    });
  });

  it("refuses writes while AI is pending/running without changing state or workspace", async () => {
    const h = await setup();
    const view = await h.inspect();
    const before = await h.sessions.get("design");
    h.busy.mockResolvedValue(true);
    await expect(
      h.designer.update(owner, "design", {
        revision: view.revision,
        reset: true,
      }),
    ).rejects.toMatchObject({ code: "design_busy" });
    await expect(h.designer.apply(owner, "design", view.previewToken)).rejects.toMatchObject({
      code: "design_busy",
    });
    await expect(
      h.designer.enqueue(owner, "design", "run", "edit", view.revision),
    ).rejects.toMatchObject({ code: "design_busy" });
    expect(await h.sessions.get("design")).toEqual(before);
    expect(h.storage.write).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("accepts existing resources, redacts previews and preserves original resource bodies on save", async () => {
    const h = await setup();
    const draft = {
      ...validDraft(),
      skillRefs: [resourceRef(source.id, "skill", "report")],
      mcpRefs: [resourceRef(source.id, "mcp", "search")],
    };
    await h.edit(draft, [source.id]);
    const view = await h.inspect();
    expect(view.issues).toEqual([]);
    for (const secret of ["secret-token", "secret-env"]) {
      expect(JSON.stringify(view)).not.toContain(secret);
    }
    // Skill content IS visible in diff preview (user reviews before saving)
    expect(JSON.stringify(view)).toContain("private-script");
    const saved = await h.designer.apply(owner, "design", view.previewToken);
    expect(saved.saved.config.skillPackages).toEqual(source.config.skillPackages);
    expect(saved.saved.config.mcpServers).toEqual(source.config.mcpServers);
  });

  it("source content changes invalidate preview even when the draft revision has not changed", async () => {
    const h = await setup();
    await h.edit({ ...validDraft(), mcpRefs: [resourceRef(source.id, "mcp", "search")] }, [
      source.id,
    ]);
    const old = await h.inspect();
    await h.agents.upsert({
      ...source,
      config: {
        ...source.config,
        mcpServers: [{ name: "search", type: "http", url: "https://example.test/new" }],
      },
    });
    const next = await h.inspect();
    expect(next.revision).toBe(old.revision);
    expect(next.previewToken).not.toBe(old.previewToken);
    await expect(h.designer.apply(owner, "design", old.previewToken)).rejects.toMatchObject({
      code: "preview_changed",
    });
    expect(
      (await h.designer.apply(owner, "design", next.previewToken)).saved.config.mcpServers?.[0]
        ?.url,
    ).toBe("https://example.test/new");
  });

  it("rejects read-only, foreign and system resource sources; revoked write grants stop saving", async () => {
    const h = await setup();
    const foreign = { ...source, id: "foreign", ownerId: "other" };
    await h.agents.upsert(foreign);
    await h.agents.upsert({ ...source, id: DESIGN_EXECUTOR_ID });
    await h.grants.grant({
      id: "grant",
      resourceId: foreign.id,
      resourceType: "agent",
      principalId: owner.userId,
      principalType: "user",
      permission: "read",
    });
    for (const id of [foreign.id, DESIGN_EXECUTOR_ID, "missing"]) {
      await expect(h.edit(validDraft(), [id])).rejects.toMatchObject({ status: 403 });
    }
    await h.grants.revoke("grant");
    await h.grants.grant({
      id: "write",
      resourceId: foreign.id,
      resourceType: "agent",
      principalId: owner.userId,
      principalType: "user",
      permission: "write",
    });
    await h.edit({ ...validDraft(), skillRefs: [resourceRef(foreign.id, "skill", "report")] }, [
      foreign.id,
    ]);
    const old = await h.inspect();
    await h.grants.revoke("write");
    const revoked = await h.inspect();
    expect(revoked.resources).toEqual([]);
    expect(revoked.issues.length).toBeGreaterThan(0);
    await expect(h.designer.apply(owner, "design", old.previewToken)).rejects.toMatchObject({
      code: "preview_changed",
    });
    await expect(h.designer.apply(owner, "design", revoked.previewToken)).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it.each([
    { skillPackages: [{ name: "new-skill", files: { "SKILL.md": "new body" } }] },
    { mcpServers: [{ name: "injected", type: "http", url: "https://example.test" }] },
    { escapeHatch: { bypass: true } },
    { webhookUrl: "https://attacker.test" },
    { model: "unknown-model" },
    { maxTurns: 0 },
  ])("keeps invalid edits reviewable but blocks apply: %j", async (parameters) => {
    const h = await setup();
    await h.edit({ ...validDraft(), parameters });
    const view = await h.inspect();
    expect(view.issues.length).toBeGreaterThan(0);
    await expect(h.designer.apply(owner, "design", view.previewToken)).rejects.toMatchObject({
      code: "invalid_config",
    });
    expect(await h.agents.list()).toHaveLength(1);
  });

  it("limits resource source input and rejects malformed drafts without mutating state", async () => {
    const h = await setup();
    const view = await h.inspect();
    for (const resourceAgentIds of ["source", [null], Array(21).fill("source")]) {
      await expect(
        h.designer.update(owner, "design", { revision: view.revision, resourceAgentIds }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(
      h.designer.update(owner, "design", { revision: view.revision, draft: {} }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect((await h.inspect()).revision).toBe(view.revision);
  });

  it("enqueues the latest manual draft, no callback and only safe resource metadata", async () => {
    const h = await setup();
    await h.edit(
      {
        ...validDraft(),
        systemPrompt: "Latest manual edit",
        skillRefs: [resourceRef(source.id, "skill", "report")],
      },
      [source.id],
    );
    const view = await h.inspect();
    await h.designer.enqueue(owner, "design", "run", "Improve this", view.revision);
    expect([...h.files.keys()]).toEqual([DRAFT_FILE]);
    expect(JSON.parse(required(h.files.get(DRAFT_FILE)).toString())).toEqual(view.draft);
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run",
        sessionId: "design",
        noCallback: true,
        prompt: "Improve this",
        release: expect.objectContaining({ version: null }),
      }),
    );
    const request = required(h.enqueue.mock.calls[0])[0];
    expect(request.release?.config.systemPrompt).toContain(
      resourceRef(source.id, "skill", "report").replaceAll('"', '\\"'),
    );
    for (const secret of ["private-script", "secret-token", "secret-env"]) {
      expect(JSON.stringify(request)).not.toContain(secret);
      expect(required(h.files.get(DRAFT_FILE)).toString()).not.toContain(secret);
    }
    expect((await h.sessions.get("design"))?.designState?.aiRunId).toBe("run");
  });

  it("workspace write failure does not enqueue or advance AI state", async () => {
    const h = await setup();
    const before = await h.sessions.get("design");
    vi.mocked(h.storage.write).mockRejectedValueOnce(new Error("disk full"));
    await expect(
      h.designer.enqueue(owner, "design", "run", "edit", (await h.inspect()).revision),
    ).rejects.toThrow("disk full");
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(await h.sessions.get("design")).toEqual(before);
  });

  it("imports completed AI output once; pending/running output never replaces the manual draft", async () => {
    const h = await setup();
    await h.runs.create({ id: "run", sessionId: "design" });
    await h.designer.enqueue(owner, "design", "run", "edit", (await h.inspect()).revision);
    h.files.set(DRAFT_FILE, Buffer.from(JSON.stringify({ ...validDraft(), name: "AI edit" })));
    expect((await h.inspect()).draft.name).toBe("New agent");
    await h.runs.claimNext(1000, Date.now());
    expect((await h.inspect()).draft.name).toBe("New agent");
    await h.runs.complete("run", "success");
    expect((await h.inspect()).draft.name).toBe("AI edit");
    h.files.set(DRAFT_FILE, Buffer.from(JSON.stringify({ ...validDraft(), name: "Late write" })));
    expect((await h.inspect()).draft.name).toBe("AI edit");
    expect(h.storage.read).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "invalid JSON", "invalid shape"])(
    "keeps the previous draft on %s AI output",
    async (kind) => {
      const h = await setup();
      await h.runs.create({ id: "run", sessionId: "design" });
      await h.designer.enqueue(owner, "design", "run", "edit", (await h.inspect()).revision);
      if (kind === "missing") h.files.delete(DRAFT_FILE);
      else h.files.set(DRAFT_FILE, Buffer.from(kind === "invalid JSON" ? "{" : "{}"));
      await h.runs.cancel("run");
      const view = await h.inspect();
      expect(view.draft).toEqual(validDraft());
      expect(view.aiIssue).toBeTruthy();
      await h.inspect();
      expect(h.storage.read).toHaveBeenCalledTimes(1);
    },
  );

  it("serializes competing edits so exactly one stale revision fails", async () => {
    const h = await setup();
    const old = await h.inspect();
    // The fake uses the session lock, but does not claim to model SQL rollback or target row locks.
    const results = await Promise.allSettled([
      h.designer.update(owner, "design", {
        revision: old.revision,
        draft: { ...old.draft, name: "A" },
      }),
      h.designer.update(owner, "design", {
        revision: old.revision,
        draft: { ...old.draft, name: "B" },
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "design_changed" },
    });
  });
});
