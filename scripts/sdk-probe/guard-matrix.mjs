// 对照实验:同样的四种配置下,旧围栏(canUseTool)和新围栏(PreToolUse hook)
// 分别拦不拦得住。
//
// 这是整个修复押注的地方 —— 声称"hook 连 bypassPermissions 都绕不过"只有
// 文档一句话作依据,不实测就等于没验证。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnv, startFakeGateway } from "./fake-gateway.mjs";

const { query } = await import("@anthropic-ai/claude-agent-sdk");

/**
 * 跑一轮:让假模型要求执行 Bash 写文件,围栏一律拒绝。
 * 看文件到底有没有被创建 —— 这是唯一不会骗人的判据。
 */
async function run({ guard, permissionMode, allowedTools }) {
  const probeFile = path.join(os.tmpdir(), `owa-p2-${Math.random().toString(36).slice(2)}.txt`);
  const gw = await startFakeGateway([
    { tool: { id: "toolu_x", name: "Bash", input: { command: `echo hit > ${probeFile}` } } },
    { text: "结束" },
  ]);
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-cfg-"));
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-ws-"));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 45_000).unref();

  let guardCalled = false;
  const options = {
    cwd: wsDir,
    maxTurns: 3,
    abortController: ac,
    settingSources: [],
    permissionMode,
    env: isolatedEnv(gw.baseUrl, cfgDir),
  };
  if (allowedTools) options.allowedTools = allowedTools;

  if (guard === "canUseTool") {
    options.canUseTool = async () => {
      guardCalled = true;
      return { behavior: "deny", message: "旧围栏:拒绝" };
    };
  } else {
    options.hooks = {
      PreToolUse: [
        {
          timeout: 660,
          hooks: [
            async () => {
              guardCalled = true;
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: "新围栏:拒绝",
                },
              };
            },
          ],
        },
      ],
    };
  }

  try {
    for await (const _m of query({ prompt: "执行", options })) {
      // 走完即可
    }
  } catch {
    // 失败也不影响判据:文件在不在是客观的
  }
  const executed = fs.existsSync(probeFile);

  gw.close();
  for (const d of [cfgDir, wsDir]) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(probeFile, { force: true });
  return { guardCalled, executed };
}

const CASES = [
  { mode: "default", allowed: undefined, desc: "default,不配白名单" },
  { mode: "default", allowed: ["Bash"], desc: "default + 裸白名单 Bash" },
  { mode: "bypassPermissions", allowed: undefined, desc: "bypassPermissions" },
  { mode: "bypassPermissions", allowed: ["Bash"], desc: "bypassPermissions + 白名单" },
];

console.log("配置                             | 旧 canUseTool | 新 PreToolUse hook");
console.log("---------------------------------|---------------|-------------------");
for (const c of CASES) {
  const oldR = await run({ guard: "canUseTool", permissionMode: c.mode, allowedTools: c.allowed });
  const newR = await run({ guard: "hook", permissionMode: c.mode, allowedTools: c.allowed });
  const fmt = (r) =>
    r.executed ? "✗ 命令执行了" : r.guardCalled ? "✓ 拦住" : "? 未调用但也没执行";
  console.log(`${c.desc.padEnd(32)} | ${fmt(oldR).padEnd(13)} | ${fmt(newR)}`);
}
process.exit(0);
