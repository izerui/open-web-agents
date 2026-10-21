// MODE=hook|canuse 时测"把答案交回给模型":PreToolUse 返回 updatedInput / canUseTool 返回 updatedInput。
// 平台现在的权限配置下(canUseTool 原样放行、PreToolUse 不表态),智能体调用 AskUserQuestion 之后:
// SDK 给模型的工具结果是什么?模型会不会接着往下做(网关收到第二次请求)?本轮怎么结束?
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnv, startFakeGateway } from "./fake-gateway.mjs";

const gw = await startFakeGateway([
  {
    tool: {
      id: "toolu_ask",
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "报告用哪种格式?",
            header: "格式",
            multiSelect: false,
            options: [
              { label: "PDF", description: "便于打印" },
              { label: "Word", description: "便于修改" },
            ],
          },
        ],
      },
    },
  },
  { text: "我先按 PDF 做了。" },
]);
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-cfg-"));
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-ws-"));
const { query } = await import("@anthropic-ai/claude-agent-sdk");
const ac = new AbortController();
setTimeout(() => ac.abort(), 60_000).unref();

const toolResults = [];
let canUseToolCalls = 0;
let finalText = "";
let subtype = "";
try {
  for await (const m of query({
    prompt: "帮我写份报告",
    options: {
      cwd: wsDir,
      maxTurns: 4,
      abortController: ac,
      settingSources: [],
      permissionMode: "default",
      env: isolatedEnv(gw.baseUrl, cfgDir),
      hooks: {
        PreToolUse: [
          {
            timeout: 660,
            hooks: [
              async (h) =>
                process.env.MODE === "hook" && h.tool_name === "AskUserQuestion"
                  ? {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "allow",
                        updatedInput: {
                          ...h.tool_input,
                          answers: { "报告用哪种格式?": "Word,另外要带目录" },
                        },
                      },
                    }
                  : {},
            ],
          },
        ],
      },
      canUseTool: async (name, input) => {
        canUseToolCalls += 1;
        if (process.env.MODE === "canuse" && name === "AskUserQuestion") {
          return {
            behavior: "allow",
            updatedInput: { ...input, answers: { "报告用哪种格式?": "Word,另外要带目录" } },
          };
        }
        return { behavior: "allow", updatedInput: input };
      },
    },
  })) {
    if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b.type === "tool_result") {
          toolResults.push({
            isError: b.is_error === true,
            content: JSON.stringify(b.content).slice(0, 300),
          });
        }
      }
    }
    if (m.type === "result") {
      finalText = String(m.result ?? "").slice(0, 80);
      subtype = m.subtype;
    }
  }
} catch (e) {
  console.log("SDK 异常:", String(e.message ?? e).slice(0, 200));
}
console.log(`canUseTool 调用 : ${canUseToolCalls}`);
console.log(`网关轮次        : ${gw.turns()}`);
console.log(
  `工具结果        : ${toolResults.map((t) => `isError=${t.isError} ${t.content}`).join(" | ") || "(无)"}`,
);
console.log(`结束            : ${subtype} / ${finalText}`);
gw.close();
