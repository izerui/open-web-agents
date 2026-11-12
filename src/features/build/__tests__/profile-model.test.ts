import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT,
  type LoadedAgent,
  advancedError,
  advancedOf,
  draftFromAgent,
  idError,
  newFilePathError,
  orchestrationReady,
  overlayConfig,
  parseSchemaText,
  saveBlock,
  saveBodyOf,
  sectionFilled,
  sectionSummary,
} from "../profile-model";

let n = 0;
const uid = () => `u${++n}`;

const full: LoadedAgent = {
  id: "expense-reviewer",
  name: "报销审核助手",
  description: "按制度初审",
  icon: "avatar:#F2B49B:pill",
  webhookUrl: "https://hooks.example/owa",
  config: {
    systemPrompt: "# 角色\n你是初审员\n## 规则\n1. 超过 5000 要审批\n2. 抬头写全称",
    model: "sonnet",
    maxTurns: 30,
    effort: "medium",
    starters: ["这张能报吗", "抬头对不对"],
    tools: [{ name: "Read" }, { name: "Grep" }],
    skillPackages: [{ name: "invoice-ocr", description: "识别发票", files: { "SKILL.md": "x" } }],
    mcpServers: [
      { name: "erp", type: "http", url: "https://erp/mcp" },
      { name: "fs", type: "stdio", command: "npx", args: ["-y", "srv"], env: { TOKEN: "{{T}}" } },
    ],
    subagents: [
      {
        name: "fx",
        description: "换汇时",
        prompt: "你负责换汇",
        model: "haiku",
        background: false,
      },
    ],
    variables: [{ name: "ERP_TOKEN", description: "令牌", required: true, secret: true }],
    inputSchema: { type: "object", properties: { amount: { type: "number" } } },
    outputSchema: { type: "object", properties: { verdict: { type: "string" } } },
    permissionMode: "plan",
    unattendedApproval: "deny",
    approvalRules: { tools: ["erp.submit"], commandPatterns: ["rm -rf"], all: false },
    escapeHatch: { foo: 1 },
    skills: ["legacy"],
  },
};

describe("draftFromAgent ↔ saveBodyOf:以已加载的完整配置为底,只覆盖表单字段", () => {
  it("原样读回后保存,配置不变(旧 skills 除外)", () => {
    const d = draftFromAgent(full, uid);
    expect(d.toolsText).toBe("Read, Grep");
    expect(d.startersText).toBe("这张能报吗\n抬头对不对");
    expect(d.effort).toBe("medium");
    expect(d.mcpServers[1]?.argsText).toBe("-y\nsrv");
    const body = saveBodyOf(d, { loadedConfig: full.config, canManageWebhook: true, isNew: false });
    const { skills: _legacy, ...expected } = full.config;
    expect(body.config).toEqual(expected);
    expect(body.name).toBe("报销审核助手");
    expect(body.icon).toBe("avatar:#F2B49B:pill");
    expect(body.webhookUrl).toBe("https://hooks.example/owa");
    expect(body.id).toBe("expense-reviewer");
    expect(body.createOnly).toBeUndefined();
  });

  it("表单把字段清空就真的删掉(推理强度、契约、开场建议、审批规则)", () => {
    const d = {
      ...draftFromAgent(full, uid),
      effort: "" as const,
      outputSchemaText: " ",
      startersText: "",
      approvalToolsText: "",
      approvalPatternsText: "",
      advancedText: "",
    };
    const c = saveBodyOf(d, {
      loadedConfig: full.config,
      canManageWebhook: true,
      isNew: false,
    }).config;
    expect("effort" in c).toBe(false);
    expect("outputSchema" in c).toBe(false);
    expect("starters" in c).toBe(false);
    expect("approvalRules" in c).toBe(false);
    expect(c.escapeHatch).toEqual({ foo: 1 });
  });

  it("开场建议最多取 4 条;子代理名称与提示词都填了才保存", () => {
    const d = {
      ...draftFromAgent(full, uid),
      startersText: "a\nb\n\nc\nd\ne",
      subagents: [
        { uid: "1", name: "x", description: "", prompt: "", model: "" },
        { uid: "2", name: "y", description: "", prompt: "p", model: "" },
      ],
    };
    const c = saveBodyOf(d, { loadedConfig: {}, canManageWebhook: true, isNew: false }).config;
    expect(c.starters).toEqual(["a", "b", "c", "d"]);
    expect(c.subagents).toEqual([{ name: "y", prompt: "p", background: false }]);
  });

  it("非所有者不带回调地址(服务端沿用原值);新建带 createOnly", () => {
    const d = { ...draftFromAgent(full, uid), webhookUrl: "" };
    expect(
      saveBodyOf(d, { loadedConfig: full.config, canManageWebhook: false, isNew: false })
        .webhookUrl,
    ).toBeUndefined();
    const fresh = { ...EMPTY_DRAFT, name: "新", systemPrompt: "p", id: "" };
    const body = saveBodyOf(fresh, { loadedConfig: {}, canManageWebhook: true, isNew: true });
    expect(body.createOnly).toBe(true);
    expect(body.id).toBeUndefined();
  });

  it("高级参数里的 approvalRules.all 合进审批规则", () => {
    const d = {
      ...draftFromAgent(full, uid),
      advancedText: '{ "approvalRules": { "all": true } }',
    };
    const c = saveBodyOf(d, {
      loadedConfig: full.config,
      canManageWebhook: true,
      isNew: false,
    }).config;
    expect(c.approvalRules).toEqual({
      tools: ["erp.submit"],
      commandPatterns: ["rm -rf"],
      all: true,
    });
  });
});

describe("overlayConfig", () => {
  it("清空的字段删掉,旧 skills 不回写", () => {
    const m = overlayConfig({ a: 1, b: 2, skills: ["x"] }, { b: undefined, c: 3 });
    expect(m).toEqual({ a: 1, c: 3 });
  });
});

describe("高级参数", () => {
  it("只展示表单没有的参数", () => {
    expect(JSON.parse(advancedOf(full.config))).toEqual({ approvalRules: { all: false } });
    expect(advancedOf({ systemPrompt: "p", model: "sonnet" })).toBe("");
  });
  it.each([
    ["", null],
    ["{}", null],
    ["[1]", "顶层必须是 JSON 对象"],
    ["{", "不是合法 JSON"],
    ['{"escapeHatch":{}}', "不能包含 escapeHatch(逃生舱不允许在这里改)"],
    ['{"systemPrompt":"x","skills":[]}', "不能包含 systemPrompt、skills,请在对应的节里改"],
    ['{"model":"x"}', "model 请在对应的节里改"],
    ['{"approvalRules":{"tools":[]}}', "approvalRules 这里只能写 all"],
  ])("advancedError(%s)", (text, err) => {
    expect(advancedError(text)).toBe(err);
  });
});

describe("parseSchemaText", () => {
  it.each([
    ["", { ok: true, empty: true }],
    ['{"type":"object"}', { ok: true, value: { type: "object" } }],
    ["[]", { ok: false, error: "顶层必须是 JSON 对象" }],
  ])("%s", (text, r) => {
    expect(parseSchemaText(text)).toMatchObject(r);
  });
  it("JSON 写错给出原因", () => {
    const r = parseSchemaText("{");
    expect(r.ok).toBe(false);
  });
});

describe("saveBlock:自动保存暂停的原因与该去哪一节", () => {
  const base = { ...draftFromAgent(full, uid) };
  const ctx = { isNew: false, takenIds: [] as string[] };
  it.each([
    [{ name: " " }, "名称为空", "identity"],
    [{ systemPrompt: "" }, "提示词为空", "prompt"],
    [{ inputSchemaText: "{" }, "输入契约的 Schema 有误", "contract"],
    [{ outputSchemaText: "[]" }, "输出契约的 Schema 有误", "contract"],
    [{ advancedText: '{"escapeHatch":1}' }, "高级参数有误", "model"],
  ])("%j", (patch, reason, section) => {
    expect(saveBlock({ ...base, ...patch }, ctx)).toEqual({ reason, section });
  });
  it("MCP 的 env 不是字符串键值 JSON", () => {
    const mcp = base.mcpServers.map((m) => ({ ...m, envText: m.type === "stdio" ? "{1" : "" }));
    expect(saveBlock({ ...base, mcpServers: mcp }, ctx)).toEqual({
      reason: "MCP「fs」的 env 不是字符串键值 JSON",
      section: "ability",
    });
  });
  it("新建时 ID 格式与占用;已建好的不再检查 ID", () => {
    const d = { ...EMPTY_DRAFT, name: "a", systemPrompt: "p" };
    expect(saveBlock({ ...d, id: "Bad ID" }, { isNew: true, takenIds: [] })?.reason).toBe(
      "ID 格式不对",
    );
    expect(saveBlock({ ...d, id: "taken" }, { isNew: true, takenIds: ["taken"] })).toEqual({
      reason: "ID 已被占用",
      section: "identity",
    });
    expect(saveBlock({ ...d, id: "taken" }, { isNew: false, takenIds: ["taken"] })).toBeNull();
    expect(saveBlock(d, { isNew: true, takenIds: [] })).toBeNull();
  });
});

describe("九节的摘要与是否已填", () => {
  const d = draftFromAgent(full, uid);
  const ctx = {
    exists: true,
    canManageWebhook: true,
    modelLabel: "Claude Sonnet",
    knowledge: { count: 2, titles: ["差旅制度.pdf", "常见问题"] },
  };
  it("摘要", () => {
    expect(sectionSummary("identity", d, ctx)).toBe("报销审核助手，2 条开场建议");
    expect(sectionSummary("prompt", d, ctx)).toBe("超过 5000 要审批；抬头写全称");
    expect(sectionSummary("model", d, ctx)).toBe("Claude Sonnet，最大 30 轮，推理强度中");
    expect(sectionSummary("ability", d, ctx)).toBe("工具 2 个，技能包 1 个，MCP 2 个，子代理 1 个");
    expect(sectionSummary("knowledge", d, ctx)).toBe("2 篇：《差旅制度》《常见问题》");
    expect(sectionSummary("vars", d, ctx)).toBe("ERP_TOKEN（密钥）");
    expect(sectionSummary("contract", d, ctx)).toBe("输入 amount；输出 verdict");
    expect(sectionSummary("approval", d, ctx)).toBe("规划模式；需审批工具 erp.submit");
    expect(sectionSummary("webhook", d, ctx)).toBe("https://hooks.example/owa");
    expect(sectionSummary("webhook", d, { ...ctx, canManageWebhook: false })).toBe("（已隐藏）");
  });
  it("空节提示可以手填或让设计器写", () => {
    const e = { ...EMPTY_DRAFT };
    const c = { ...ctx, exists: false, knowledge: { count: 0, titles: [] } };
    expect(sectionFilled("identity", e, c)).toBe(false);
    expect(sectionSummary("identity", e, c)).toBe("还没填：点开直接手动填，或让智能体设计器写");
    expect(sectionFilled("model", e, c)).toBe(false);
    expect(sectionFilled("model", e, ctx)).toBe(true);
    expect(sectionSummary("ability", { ...d, toolsText: "" }, ctx)).toContain("工具不限制");
  });
  it("编排完整 = 名称与提示词非空", () => {
    expect(orchestrationReady(d)).toBe(true);
    expect(orchestrationReady({ ...d, systemPrompt: " " })).toBe(false);
  });
});

describe("技能包附属文件路径校验", () => {
  const files = { "SKILL.md": "x", "templates/a.json": "" };
  it.each([
    ["", "路径不能为空"],
    ["SKILL.md", "不能和 SKILL.md 重名"],
    ["templates/a.json", "已有同名文件"],
    ["../shared/x.json", "不能包含 .."],
    ["/etc/x", "不能用绝对路径"],
    ["a b.md", "只允许字母、数字、._- 和 /"],
    ["scripts/run.py", null],
  ])("%s", (p, err) => {
    expect(newFilePathError(p, files)).toBe(err);
  });
  it("和已有文件路径冲突", () => {
    expect(newFilePathError("templates", files)).not.toBeNull();
  });
});

describe("idError", () => {
  it("与新建弹层同一条规则", () => {
    expect(idError("", [])).toBe("");
    expect(idError("Bad", [])).toContain("小写字母");
    expect(idError("ok-id", ["ok-id"])).toBe("ID 已被占用");
  });
});
