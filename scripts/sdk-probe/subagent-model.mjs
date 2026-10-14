// 子代理单独指定模型:主 agent 用 sonnet,子代理配 model:"haiku" —— 子代理发给网关的请求
// 用的是不是 ANTHROPIC_DEFAULT_HAIKU_MODEL 映射出来的模型。判据看假网关收到的请求体里的 model。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnv, startFakeGateway } from "./fake-gateway.mjs";

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const pins = {
  ANTHROPIC_DEFAULT_FABLE_MODEL: "pinned-fable",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "pinned-opus",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "pinned-sonnet",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "pinned-haiku",
};

async function run(subagentModel) {
  const gw = await startFakeGateway([
    // 主 agent:调用子代理
    {
      tool: {
        id: "toolu_sub",
        name: "Agent",
        input: { subagent_type: "summarizer", description: "汇总", prompt: "把材料汇总成一句话" },
      },
    },
    { text: "子代理:汇总完成" }, // 子代理的回答
    { text: "主 agent:收到汇总" }, // 主 agent 收尾
  ]);
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-cfg-"));
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-ws-"));
  for await (const _ of query({
    prompt: "请让子代理汇总",
    options: {
      cwd: wsDir,
      model: "sonnet",
      maxTurns: 4,
      settingSources: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      agents: {
        summarizer: {
          description: "需要汇总材料时",
          prompt: "你负责汇总",
          ...(subagentModel ? { model: subagentModel } : {}),
          background: false,
        },
      },
      env: { ...isolatedEnv(gw.baseUrl, cfgDir), ...pins },
    },
  })) {
  }
  gw.close();
  return gw.seenRequests.map((r) => r?.model);
}

console.log("子代理 model:haiku →", (await run("haiku")).join(" , "));
console.log("子代理不指定      →", (await run(undefined)).join(" , "));
