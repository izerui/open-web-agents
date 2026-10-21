// MCP 测试连接的流程:先单独校验这个 MCP,再按运行时的方式换入本人保存的变量值,最后去连。
// 真正的连接(地址守卫、协议握手、stdio 进程)在适配器里,这里只编排,便于单测。

import type { McpDef } from "@/lib/shared";
import type { VariableDef } from "../domain/config";
import { type McpCheckResult, checkMcpConfig, prepareMcpForCheck } from "../domain/mcp-check";

export interface McpConnectionCheckDeps {
  allowStdioMcp: boolean;
  /** 本人在这个智能体上保存的变量值(含密钥) */
  variablesOf(agentId: string, userId: string): Promise<Record<string, string>>;
  probe(def: McpDef, secrets: string[]): Promise<McpCheckResult>;
}

export class McpConnectionCheck {
  constructor(private readonly deps: McpConnectionCheckDeps) {}

  /**
   * agentId:变量值从哪个智能体取(新建、还没保存的智能体没有,引用了变量就会报缺少变量值);
   * variables:当前草稿里声明的变量 —— 运行时只替换声明过的变量,测试也一样
   */
  async check(input: {
    def: McpDef;
    variables?: VariableDef[];
    agentId?: string;
    userId: string;
  }): Promise<McpCheckResult> {
    const invalid = checkMcpConfig(input.def, this.deps.allowStdioMcp);
    if (invalid) return { ok: false, ...invalid };
    const saved = input.agentId ? await this.deps.variablesOf(input.agentId, input.userId) : {};
    const prepared = prepareMcpForCheck(input.def, input.variables, saved);
    if ("missing" in prepared) {
      return {
        ok: false,
        kind: "missing_variables",
        missing: prepared.missing,
        message: input.agentId
          ? `这些变量没有值(或没有在变量里声明):${prepared.missing.join("、")}。在智能体的变量里填写后再测试`
          : `这些变量还没有值:${prepared.missing.join("、")}。先保存智能体并填写变量值后再测试`,
      };
    }
    return this.deps.probe(prepared.def, prepared.secrets);
  }
}
