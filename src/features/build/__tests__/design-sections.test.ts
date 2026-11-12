import type { DesignDraft } from "@/lib/modules/agent/domain/design";
import { describe, expect, it } from "vitest";
import {
  changedSections,
  evalFixPrompt,
  groupChanges,
  mergeDesignSections,
  sectionOfChangePath,
  trialFeedbackPrompt,
} from "../design-sections";

describe("sectionOfChangePath:设计器差异路径归到档案卡的节", () => {
  it.each([
    ["name", "identity"],
    ["description", "identity"],
    ["icon", "identity"],
    ["config.starters", "identity"],
    ["config.systemPrompt", "prompt"],
    ["config.model", "model"],
    ["config.maxTurns", "model"],
    ["config.effort", "model"],
    ["config.tools", "ability"],
    ["config.skillPackages[invoice-ocr].files.SKILL.md", "ability"],
    ["config.mcpServers[erp]", "ability"],
    ["config.subagents[fx].prompt", "ability"],
    ["config.variables[ERP_TOKEN]", "vars"],
    ["config.inputSchema.properties.amount", "contract"],
    ["config.outputSchema", "contract"],
    ["config.permissionMode", "approval"],
    ["config.approvalRules.tools", "approval"],
    ["config.unattendedApproval", "approval"],
    ["config.somethingNew", "model"],
  ])("%s → %s", (path, section) => {
    expect(sectionOfChangePath(path)).toBe(section);
  });

  it("groupChanges 按档案卡的节顺序分组", () => {
    const g = groupChanges([
      { path: "config.outputSchema", kind: "added", after: {} },
      { path: "config.systemPrompt", kind: "changed", before: "a", after: "b" },
      { path: "name", kind: "changed", before: "x", after: "y" },
      { path: "config.inputSchema", kind: "added", after: {} },
    ]);
    expect(g.map((x) => [x.section, x.changes.length])).toEqual([
      ["identity", 1],
      ["prompt", 1],
      ["contract", 2],
    ]);
  });
});

const base: DesignDraft = {
  name: "旧名",
  description: "旧描述",
  systemPrompt: "旧提示词",
  parameters: { model: "sonnet", maxTurns: 20, starters: ["a"], permissionMode: "plan" },
  skillRefs: [],
  mcpRefs: [],
  skillPackages: [{ name: "s", description: "d", files: { "SKILL.md": "x" } }],
};
const proposal: DesignDraft = {
  name: "新名",
  description: "旧描述",
  systemPrompt: "新提示词",
  parameters: {
    model: "opus",
    maxTurns: 20,
    starters: ["a"],
    outputSchema: { type: "object" },
  },
  skillRefs: ["ref1"],
  mcpRefs: [],
  skillPackages: [{ name: "s", description: "d", files: { "SKILL.md": "y" } }],
};

describe("mergeDesignSections:只取设计器提议里的某几节,其余保持基线", () => {
  it("只取提示词", () => {
    const m = mergeDesignSections(base, proposal, ["prompt"]);
    expect(m).toEqual({ ...base, systemPrompt: "新提示词" });
  });
  it("取契约与审批:新增的参数带上,提议里删掉的参数也删掉", () => {
    const m = mergeDesignSections(base, proposal, ["contract", "approval"]);
    expect(m.parameters).toEqual({
      model: "sonnet",
      maxTurns: 20,
      starters: ["a"],
      outputSchema: { type: "object" },
    });
    expect(m.name).toBe("旧名");
  });
  it("能力节带上技能包、MCP 与资源引用", () => {
    const m = mergeDesignSections(base, proposal, ["ability"]);
    expect(m.skillRefs).toEqual(["ref1"]);
    expect(m.skillPackages?.[0]?.files["SKILL.md"]).toBe("y");
    expect(m.systemPrompt).toBe("旧提示词");
  });
  it("新建(没有目标)时名称必须一起带上,否则存不进去", () => {
    const m = mergeDesignSections(base, proposal, ["prompt"], { requireIdentity: true });
    expect(m.name).toBe("新名");
  });
  it("changedSections 列出提议与基线不同的节", () => {
    expect(changedSections(base, proposal)).toEqual(["identity", "prompt", "model", "ability", "contract", "approval"]);
    expect(changedSections(base, base)).toEqual([]);
  });
});

describe("提示词拼装", () => {
  it("评测失败交给设计器修复:带上输入、输出快照、断言与原因", () => {
    const text = evalFixPrompt([
      {
        caseName: "外币换算",
        input: { amount: 1000 },
        assertions: "amount_cny = 7103.2；须包含「开票日汇率」",
        failures: ["结构化字段不符"],
        output: { status: "success", structured: { amount_cny: 7180 } },
      },
      {
        caseName: "餐饮超标准",
        input: "680 元餐饮",
        assertions: "期望成功",
        failures: ["正文未包含「超出餐饮标准」"],
        output: { status: "success", text: "金额合理" },
      },
    ]);
    expect(text).toContain("2 个评测用例没有通过");
    expect(text).toContain("【用例】外币换算");
    expect(text).toContain('"amount": 1000');
    expect(text).toContain("amount_cny = 7103.2");
    expect(text).toContain('"amount_cny": 7180');
    expect(text).toContain("结构化字段不符");
    expect(text).toContain("金额合理");
    expect(text).toContain("请分析原因并修改草稿");
  });

  it("试运行结果反馈", () => {
    const text = trialFeedbackPrompt({
      promptPreview: "这张能报吗",
      text: "可以",
      error: { message: "超时" },
    });
    expect(text).toContain("【输入】\n这张能报吗");
    expect(text).toContain("【输出】\n可以");
    expect(text).toContain("【错误】\n超时");
  });
});
