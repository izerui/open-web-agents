import { describe, expect, it } from "vitest";
import type { Agent } from "../../ports";
import {
  designHash,
  designResources,
  designSnapshot,
  draftOf,
  parseDesign,
  resolveDesign,
  resourceRef,
} from "../design";

const source: Agent = {
  id: "source",
  ownerId: "owner",
  name: "Existing resources",
  config: {
    model: "sonnet",
    systemPrompt: "Use existing resources",
    escapeHatch: { privateOption: "hatch-secret" },
    skillPackages: [
      {
        name: "report",
        description: "Write a report",
        files: { "SKILL.md": "# Report", "scripts/report.sh": "private-script" },
      },
    ],
    mcpServers: [
      {
        name: "search",
        type: "http",
        url: "https://user:url-secret@example.test/mcp?token=query-secret",
        env: { TOKEN: "env-secret" },
        args: ["arg-secret"],
      },
    ],
  },
};

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test fixture");
  return value;
}

describe("platform design drafts", () => {
  it("exports references without skill files, MCP secrets or escape hatch", () => {
    const draft = draftOf(source);
    expect(draft.skillRefs).toEqual([resourceRef("source", "skill", "report")]);
    expect(draft.mcpRefs).toEqual([resourceRef("source", "mcp", "search")]);
    expect(draft.parameters).toEqual({ model: "sonnet" });
    expect(designResources([source])).toEqual([
      {
        ref: draft.skillRefs[0],
        kind: "skill",
        name: "report",
        description: "Write a report",
        agentId: "source",
        agentName: source.name,
      },
      {
        ref: draft.mcpRefs[0],
        kind: "mcp",
        name: "search",
        agentId: "source",
        agentName: source.name,
      },
    ]);
    const visible = JSON.stringify([draft, designResources([source]), designSnapshot(source)]);
    for (const secret of [
      "private-script",
      "hatch-secret",
      "url-secret",
      "query-secret",
      "env-secret",
      "arg-secret",
    ]) {
      expect(visible).not.toContain(secret);
    }
    expect(designSnapshot(source).config.skillPackages?.[0]?.files).toEqual({});
    expect(designSnapshot(source).config.mcpServers).toEqual([{ name: "search", type: "http" }]);
  });

  it("resolves only existing references and clones their original content", () => {
    const saved = resolveDesign(draftOf(source), [source]);
    expect(saved.config.skillPackages).toEqual(source.config.skillPackages);
    expect(saved.config.mcpServers).toEqual(source.config.mcpServers);
    expect(saved.config.escapeHatch).toBeUndefined();
    required(saved.config.skillPackages?.[0]).files["SKILL.md"] = "changed";
    required(saved.config.mcpServers?.[0]?.env).TOKEN = "changed";
    expect(source.config.skillPackages?.[0]?.files["SKILL.md"]).toBe("# Report");
    expect(source.config.mcpServers?.[0]?.env?.TOKEN).toBe("env-secret");
  });

  it.each([
    "skills",
    "skillPackages",
    "mcpServers",
    "escapeHatch",
    "name",
    "description",
    "systemPrompt",
  ])("rejects inline protected parameter %s", (field) => {
    const draft = draftOf(source);
    draft.parameters[field] = [];
    expect(() => resolveDesign(draft, [source])).toThrow(/parameters/);
  });

  it("rejects invented refs, wrong resource kinds and revoked resources", () => {
    const draft = draftOf(source);
    expect(() => resolveDesign(draft, [])).toThrow(/资源/);
    expect(() => resolveDesign({ ...draft, skillRefs: ["invented"] }, [source])).toThrow(/资源/);
    expect(() => resolveDesign({ ...draft, skillRefs: draft.mcpRefs }, [source])).toThrow(/资源/);
  });

  it.each(["skill", "mcp"] as const)(
    "rejects duplicate %s names from different sources",
    (kind) => {
      const second = { ...source, id: "second" };
      const draft = draftOf(source);
      if (kind === "skill") draft.skillRefs.push(resourceRef(second.id, kind, "report"));
      else draft.mcpRefs.push(resourceRef(second.id, kind, "search"));
      expect(() => resolveDesign(draft, [source, second])).toThrow(/名称重复/);
    },
  );

  it.each([
    null,
    [],
    "draft",
    { ...draftOf(), name: 1 },
    { ...draftOf(), description: null },
    { ...draftOf(), systemPrompt: [] },
    { ...draftOf(), parameters: [] },
    { ...draftOf(), parameters: null },
    { ...draftOf(), skillRefs: [1] },
    { ...draftOf(), mcpRefs: "mcp" },
    { ...draftOf(), skillRefs: ["a", "a"] },
    { ...draftOf(), mcpRefs: ["a", "a"] },
    { ...draftOf(), skillPackages: [] },
    { ...draftOf(), systemPrompt: "x".repeat(500_001) },
  ])("rejects malformed or oversized draft %#", (raw) => {
    expect(() => parseDesign(raw)).toThrow();
  });

  it("keeps incomplete drafts editable but refuses to resolve them for saving", () => {
    expect(parseDesign(draftOf())).toEqual(draftOf());
    expect(() => resolveDesign(draftOf(), [])).toThrow(/name/);
    expect(() => resolveDesign({ ...draftOf(), name: "Named" }, [])).toThrow(/提示词/);
  });

  it("does not accept webhook or other unrecognized bundle parameters", () => {
    expect(() =>
      resolveDesign(
        {
          ...draftOf(source),
          parameters: { webhookUrl: "https://attacker.test" },
        },
        [source],
      ),
    ).toThrow(/webhookUrl/);
  });

  it("hashes object key ordering consistently but detects content and reference changes", () => {
    expect(designHash({ b: 2, a: 1 })).toBe(designHash({ a: 1, b: 2 }));
    expect(designHash(draftOf(source))).not.toBe(designHash({ ...draftOf(source), mcpRefs: [] }));
    expect(resourceRef("a,b", "skill", "c")).not.toBe(resourceRef("a", "skill", "b,c"));
  });
});
