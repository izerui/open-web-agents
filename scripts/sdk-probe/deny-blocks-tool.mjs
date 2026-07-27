// 最小验证:hook 会被调用吗?deny 拦得住吗?
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnv, startFakeGateway } from "./fake-gateway.mjs";

const PROBE_FILE = path.join(os.tmpdir(), `owa-probe-${Date.now()}.txt`);
fs.rmSync(PROBE_FILE, { force: true });

const gw = await startFakeGateway([
  { tool: { id: "toolu_probe", name: "Bash", input: { command: `echo hit > ${PROBE_FILE}` } } },
  { text: "好的,我停下了。" },
]);
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-cfg-"));
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-ws-"));

const hookCalls = [];
const { query } = await import("@anthropic-ai/claude-agent-sdk");
const ac = new AbortController();
setTimeout(() => ac.abort(), 60_000).unref();

const toolResults = [];
let finalText = "";
try {
  for await (const m of query({
    prompt: "执行那条命令",
    options: {
      cwd: wsDir,
      maxTurns: 3,
      abortController: ac,
      settingSources: [],
      env: isolatedEnv(gw.baseUrl, cfgDir),
      hooks: {
        PreToolUse: [
          {
            timeout: 660,
            hooks: [
              async (input) => {
                hookCalls.push(input.tool_name);
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: "围栏实证:一律拒绝",
                  },
                };
              },
            ],
          },
        ],
      },
    },
  })) {
    if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) {
        if (b.type === "tool_result") {
          toolResults.push({
            isError: b.is_error === true,
            content: JSON.stringify(b.content).slice(0, 120),
          });
        }
      }
    }
    if (m.type === "result") finalText = String(m.result ?? "").slice(0, 80);
  }
} catch (e) {
  console.log("SDK 异常:", String(e.message ?? e).slice(0, 90));
}

console.log(`网关轮次      : ${gw.turns()}`);
console.log(`hook 被调用   : ${hookCalls.length ? hookCalls.join(",") : "❌ 从未被调用"}`);
console.log(
  `工具结果      : ${toolResults.map((t) => `isError=${t.isError} ${t.content}`).join(" | ") || "(无)"}`,
);
console.log(
  `命令是否执行  : ${fs.existsSync(PROBE_FILE) ? "❌ 文件被创建了 —— 围栏没拦住" : "✅ 文件不存在"}`,
);
console.log(`最终回复      : ${finalText}`);

gw.close();
fs.rmSync(cfgDir, { recursive: true, force: true });
fs.rmSync(wsDir, { recursive: true, force: true });
fs.rmSync(PROBE_FILE, { force: true });
process.exit(0);
