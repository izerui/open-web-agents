import { validateSkillPackages } from "@/lib/shared/skill-package";
import { describe, expect, it } from "vitest";
import type { Agent } from "../../ports";
import {
  type DesignDraft,
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

describe("platform design drafts", () => {
  it("exports inline skills and redacted MCP, without escape hatch or raw MCP secrets", () => {
    const draft = draftOf(source);
    expect(draft.skillRefs).toEqual([]);
    expect(draft.mcpRefs).toEqual([]);
    expect(draft.parameters).toEqual({ model: "sonnet" });
    expect(draft.skillPackages).toEqual(source.config.skillPackages);
    expect(draft.mcpServers?.[0]?.name).toBe("search");

    const visible = JSON.stringify([draft, designResources([source]), designSnapshot(source)]);
    for (const secret of ["hatch-secret", "url-secret", "query-secret", "env-secret"]) {
      expect(visible).not.toContain(secret);
    }
    expect(JSON.stringify(draft)).toContain("private-script");
    expect(draft.mcpServers?.[0]?.env?.TOKEN).toBe("***");
    // Snapshot shows skill content for diff preview
    expect(designSnapshot(source).config.skillPackages?.[0]?.files["SKILL.md"]).toBe("# Report");
    // Snapshot shows redacted MCP (name + type preserved, secrets redacted)
    expect(designSnapshot(source).config.mcpServers?.[0]?.name).toBe("search");
    expect(designSnapshot(source).config.mcpServers?.[0]?.env?.TOKEN).toBe("***");
    expect(designSnapshot(source).config.escapeHatch).toBeUndefined();
  });

  it("resolves inline skills and redacted MCP from draft", () => {
    const saved = resolveDesign(draftOf(source), [source]);
    expect(saved.config.skillPackages).toEqual(source.config.skillPackages);
    expect(saved.config.mcpServers?.[0]?.name).toBe("search");
    expect(saved.config.mcpServers?.[0]?.env?.TOKEN).toBe("***");
    expect(saved.config.escapeHatch).toBeUndefined();
  });

  it("AI editing inline skill content applies on resolve", () => {
    const draft = draftOf(source);
    if (draft.skillPackages?.[0]) {
      draft.skillPackages[0] = {
        ...draft.skillPackages[0],
        files: { ...draft.skillPackages[0].files, "SKILL.md": "# Modified Report" },
      };
    }
    const saved = resolveDesign(draft, [source]);
    expect(saved.config.skillPackages?.[0]?.files["SKILL.md"]).toBe("# Modified Report");
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

  it("rejects invented refs and wrong resource kinds", () => {
    const draft = draftOf(source);
    expect(() => resolveDesign({ ...draft, skillRefs: ["invented"] }, [source])).toThrow(/资源/);
    expect(() =>
      resolveDesign({ ...draft, skillRefs: [resourceRef("source", "mcp", "search")] }, [source]),
    ).toThrow(/资源/);
  });

  it("rejects duplicate ref names from different sources", () => {
    const second = { ...source, id: "second" };
    const draft: DesignDraft = {
      ...draftOf(),
      name: "test",
      systemPrompt: "test",
      skillRefs: [
        resourceRef(source.id, "skill", "report"),
        resourceRef(second.id, "skill", "report"),
      ],
    };
    expect(() => resolveDesign(draft, [source, second])).toThrow(/重复/);
  });

  it("inline skills add alongside refs without name conflict", () => {
    const draft = draftOf(source);
    draft.skillPackages = [
      ...(draft.skillPackages ?? []),
      { name: "new-skill", description: "AI generated", files: { "SKILL.md": "# New" } },
    ];
    const result = resolveDesign(draft, [source]);
    expect(result.config.skillPackages?.map((s) => s.name).sort()).toEqual(["new-skill", "report"]);
  });

  it("rejects same-name inline and ref resources", () => {
    const draft = draftOf(source);
    // Add a ref pointing to the same skill name as inline
    draft.skillRefs = [resourceRef(source.id, "skill", "report")];
    expect(() => resolveDesign(draft, [source])).toThrow(/同时存在/);
  });

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
    { ...draftOf(), skillPackages: "not-array" },
    { ...draftOf(), mcpServers: "not-array" },
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
    expect(designHash(draftOf(source))).not.toBe(
      designHash({ ...draftOf(source), skillPackages: [] }),
    );
    expect(resourceRef("a,b", "skill", "c")).not.toBe(resourceRef("a", "skill", "b,c"));
  });

  it("variables survive draftOf → resolveDesign round trip without leaking values", () => {
    const agentWithVars: Agent = {
      ...source,
      config: {
        ...source.config,
        variables: [
          { name: "API_KEY", description: "密钥", required: true, secret: true },
          { name: "BASE_URL", description: "地址", required: false, secret: false },
        ],
        mcpServers: [
          { type: "http", name: "api", url: "https://{{BASE_URL}}/v1?token={{API_KEY}}" },
        ],
      },
    };

    const draft = draftOf(agentWithVars);

    expect(draft.parameters.variables).toEqual([
      { name: "API_KEY", description: "密钥", required: true, secret: true },
      { name: "BASE_URL", description: "地址", required: false, secret: false },
    ]);

    const snapshot = resolveDesign(draft, [agentWithVars]);
    expect(snapshot.config.variables).toEqual(agentWithVars.config.variables);

    expect(snapshot.config.mcpServers?.[0]?.url).toContain("{{BASE_URL}}");
    expect(snapshot.config.mcpServers?.[0]?.url).toContain("{{API_KEY}}");

    expect(JSON.stringify(draft)).not.toContain("sk-");
    expect(JSON.stringify(snapshot)).not.toContain("sk-");
  });

  it("合法多文件技能包超过旧 500K 限制仍能载入设计器", () => {
    const fileContent = "x".repeat(250 * 1024);
    const bigAgent: Agent = {
      id: "big-skill",
      ownerId: "owner",
      name: "大技能包",
      config: {
        model: "sonnet",
        systemPrompt: "test",
        skillPackages: [
          {
            name: "big-tool",
            description: "大工具",
            files: {
              "SKILL.md": "# 步骤\n运行脚本",
              "scripts/large.py": fileContent,
              "data/corpus.txt": fileContent,
            },
          },
        ],
      },
    };

    expect(validateSkillPackages(bigAgent.config.skillPackages)).toEqual([]);

    const draft = draftOf(bigAgent);
    const draftJson = JSON.stringify(draft);
    expect(draftJson.length).toBeGreaterThan(500_000);

    const parsed = parseDesign(JSON.parse(draftJson));
    expect(parsed.skillPackages?.[0]?.name).toBe("big-tool");
    expect(parsed.skillPackages?.[0]?.files["scripts/large.py"]).toBe(fileContent);

    const resolved = resolveDesign(parsed, []);
    expect(resolved.config.skillPackages?.[0]?.files["scripts/large.py"]).toBe(fileContent);
    expect(resolved.config.skillPackages?.[0]?.files["data/corpus.txt"]).toBe(fileContent);
  });

  it("7 个 250KiB 换行文件(JSON 膨胀 2x)仍能通过设计草稿限制", () => {
    const newlineContent = "\n".repeat(250 * 1024);
    const files: Record<string, string> = { "SKILL.md": "# test" };
    for (let i = 0; i < 7; i++) files[`scripts/f${i}.py`] = newlineContent;

    const pkg = { name: "newline-heavy", description: "换行文件", files };
    expect(validateSkillPackages([pkg])).toEqual([]);

    const draft = {
      name: "t",
      description: "",
      systemPrompt: "",
      parameters: {},
      skillRefs: [] as string[],
      mcpRefs: [] as string[],
      skillPackages: [pkg],
    };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(draft)).length;
    expect(jsonBytes).toBeGreaterThan(3_000_000);

    const parsed = parseDesign(draft);
    expect(parsed.skillPackages?.[0]?.files["scripts/f0.py"]).toBe(newlineContent);
  });

  it("超过容量上限时报明确错误", () => {
    const huge = "x".repeat(2_700_000);
    const draft = {
      name: "t",
      description: "",
      systemPrompt: "",
      parameters: {},
      skillRefs: [],
      mcpRefs: [],
      skillPackages: [
        { name: "huge", description: "d", files: { "SKILL.md": huge, "a.py": huge } },
      ],
    };
    expect(() => parseDesign(draft)).toThrow(/设计草稿过大.*MB/);
  });
});
