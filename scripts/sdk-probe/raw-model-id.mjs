// 直接传上游真实 modelId(而非别名)给 SDK:
// 1) 主 agent 与子代理发给网关的 model 是否就是传入的真实 id;
// 2) 运行中出现的其他 model(后台小模型)取自 ANTHROPIC_SMALL_FAST_MODEL 还是 ANTHROPIC_DEFAULT_HAIKU_MODEL;
// 3) result.modelUsage 的键是否为真实 id(计量按它匹配价目);
// 4) CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 时 Bash 子进程是否还读得到 ANTHROPIC_API_KEY。
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
  ANTHROPIC_SMALL_FAST_MODEL: "pinned-small-fast",
};

async function runModels() {
  const gw = await startFakeGateway([
    {
      tool: {
        id: "toolu_sub",
        name: "Agent",
        input: { subagent_type: "summarizer", description: "汇总", prompt: "汇总" },
      },
    },
    { text: "子代理完成" },
    { text: "主 agent 收尾" },
  ]);
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-cfg-"));
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-ws-"));
  let usageKeys = [];
  for await (const m of query({
    prompt: "请让子代理汇总",
    options: {
      cwd: wsDir,
      model: "vendor-main-model-x",
      maxTurns: 4,
      settingSources: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      agents: {
        summarizer: {
          description: "需要汇总材料时",
          prompt: "你负责汇总",
          model: "vendor-sub-model-y",
          background: false,
        },
      },
      env: { ...isolatedEnv(gw.baseUrl, cfgDir), ...pins },
    },
  })) {
    if (m.type === "result") usageKeys = Object.keys(m.modelUsage ?? {});
  }
  gw.close();
  return { sent: gw.seenRequests.map((r) => r?.model), usageKeys };
}

// 与生产一致:default 权限模式 + 全部放行的 canUseTool。用预置脚本读环境变量,避开 SDK 对 $ 展开的拦截
async function keyVisibleToBash(scrub) {
  const wsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owa-ws-")));
  fs.writeFileSync(
    path.join(wsDir, "probe.py"),
    "import os\nprint('KEY=[' + os.environ.get('ANTHROPIC_API_KEY', '') + ']')\n",
  );
  const gw = await startFakeGateway([
    {
      tool: {
        id: "toolu_bash",
        name: "Bash",
        input: { command: "python3 probe.py", description: "p" },
      },
    },
    { text: "完成" },
  ]);
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-cfg-"));
  let output = "";
  for await (const m of query({
    prompt: "run",
    options: {
      cwd: wsDir,
      model: "vendor-main-model-x",
      maxTurns: 3,
      settingSources: [],
      permissionMode: "default",
      canUseTool: async (_t, input) => ({ behavior: "allow", updatedInput: input }),
      env: {
        ...isolatedEnv(gw.baseUrl, cfgDir),
        ...(scrub ? { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" } : {}),
      },
    },
  })) {
    if (m.type === "user") {
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_result") output = JSON.stringify(b.content);
      }
    }
  }
  gw.close();
  return output;
}

const r = await runModels();
console.log("发给网关的 model:", r.sent.join(" , "));
console.log("modelUsage 键:   ", r.usageKeys.join(" , "));
console.log("Bash 读 Key(未清理):", JSON.stringify(await keyVisibleToBash(false)));
console.log("Bash 读 Key(清理=1):", JSON.stringify(await keyVisibleToBash(true)));
