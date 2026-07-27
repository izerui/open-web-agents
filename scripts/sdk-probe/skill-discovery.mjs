// settingSources: [] 到底会不会让 skill 消失?plugins 能不能救回来?
//
// 文档说"如果显式设置 settingSources 并省略 user/project,Skills 不会加载",
// 但这条正好和多租户隔离(不读宿主的 CLAUDE.md)冲突 —— 两个都要,只能实测怎么兼得。
//
// 判据用 SDK 的 init 消息:它会列出本次实际加载了哪些 skill 和 plugin,
// 比"看 agent 会不会用"客观得多。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnv, startFakeGateway } from "./fake-gateway.mjs";

const { query } = await import("@anthropic-ai/claude-agent-sdk");

/** 造一个 SKILL.md。 */
function writeSkill(root, name) {
  const dir = path.join(root, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: 探针用的 skill,用于确认它到底有没有被发现\n---\n\n执行时打印一句话。\n`,
  );
}

/** 跑一轮,只读 init 消息里的 skills/plugins。 */
async function inspect(label, extra, cfgDir, wsDir) {
  const gw = await startFakeGateway([{ text: "ok" }]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 40_000).unref();

  let init = null;
  try {
    for await (const m of query({
      prompt: "hi",
      options: {
        cwd: wsDir,
        maxTurns: 1,
        abortController: ac,
        env: isolatedEnv(gw.baseUrl, cfgDir),
        ...extra,
      },
    })) {
      if (m.type === "system" && m.subtype === "init") init = m;
    }
  } catch (e) {
    if (!init) console.log(`  (${label} 异常: ${String(e.message ?? e).slice(0, 60)})`);
  }
  gw.close();

  const skills = init?.skills ?? [];
  const plugins = (init?.plugins ?? []).map((p) => p.name ?? p);
  console.log(
    `${label.padEnd(38)} skills=${JSON.stringify(skills)} plugins=${JSON.stringify(plugins)}`,
  );
  return skills;
}

// 用户级 skill 放在 CLAUDE_CONFIG_DIR 下(相当于 ~/.claude/skills/)
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-cfg-"));
writeSkill(cfgDir, "probe-user-skill");

// plugin 形态的 skill:独立目录,靠 plugins 选项显式加载
const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "owa-plugin-"));
writeSkill(pluginRoot, "probe-plugin-skill");

const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-ws-"));

console.log("配置                                   实际加载到的 skill");
console.log("-".repeat(96));
await inspect("① 不设 settingSources(SDK 默认)", {}, cfgDir, wsDir);
await inspect("② settingSources: [] (当前实现)", { settingSources: [] }, cfgDir, wsDir);
await inspect(
  "③ settingSources: [] + plugins",
  { settingSources: [], plugins: [{ type: "local", path: pluginRoot }] },
  cfgDir,
  wsDir,
);
await inspect(
  "④ ③ 再加 skills:'all'",
  { settingSources: [], plugins: [{ type: "local", path: pluginRoot }], skills: "all" },
  cfgDir,
  wsDir,
);

for (const d of [cfgDir, pluginRoot, wsDir]) fs.rmSync(d, { recursive: true, force: true });
process.exit(0);
