// 分支续接的真实语义。
//
// 背景(2026-10 实测):resume 同一个 session id 不会产生新 id,所有轮次追加进同一份 jsonl。
// 于是"从第 k 轮之前分叉"只按 session id 续接,模型看到的是【最新】的完整对话。
// 这里验证 resumeSessionAt(某条消息 uuid)+ forkSession 能否回到中间某轮的状态,
// 以及实时消息流里能拿到哪些 uuid、它们与 jsonl 里的行是否一一对应。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnv, startFakeGateway } from "./fake-gateway.mjs";

const gw = await startFakeGateway([
  { text: "答一" },
  { text: "答二" },
  { text: "答分支" },
  { text: "答分支后续" },
]);
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-cfg-"));
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-ws-"));
const { query } = await import("@anthropic-ai/claude-agent-sdk");
const base = { cwd: wsDir, maxTurns: 2, settingSources: [], env: isolatedEnv(gw.baseUrl, cfgDir) };

async function run(prompt, extra = {}) {
  let id;
  const uuids = [];
  for await (const m of query({ prompt, options: { ...base, ...extra } })) {
    if (m.type === "system" && m.subtype === "init") id = m.session_id;
    if ((m.type === "assistant" || m.type === "user") && m.uuid) uuids.push(`${m.type}:${m.uuid}`);
  }
  return { id, uuids, last: uuids.at(-1)?.split(":")[1] };
}

const r1 = await run("P1");
const r2 = await run("P2", { resume: r1.id });
// 从"第 1 轮之后"分叉:续接第 1 轮最后一条消息,分到新文件
const b = await run("P3-branch-after-1", {
  resume: r1.id,
  resumeSessionAt: r1.last,
  forkSession: true,
});
// 分支之后继续聊:续接分支自己的会话
const b2 = await run("P4-after-branch", { resume: b.id });

console.log("r1", r1.id.slice(0, 8), r1.uuids);
console.log("r2", r2.id.slice(0, 8), r2.uuids);
console.log("b ", b.id.slice(0, 8), b.uuids);
console.log("b2", b2.id.slice(0, 8), b2.uuids);
const prompts = (i) => JSON.stringify(gw.seenRequests[i]?.messages ?? []).match(/P\d[^"\\]*/g);
for (let i = 0; i < gw.seenRequests.length; i++) console.log(`请求#${i + 1} 模型看到:`, prompts(i));

const walk = (d) =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of walk(cfgDir).filter((f) => f.endsWith(".jsonl"))) {
  console.log(`\n=== ${path.basename(f).slice(0, 8)}`);
  for (const j of fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))) {
    if (j.type !== "user" && j.type !== "assistant") continue;
    const txt = JSON.stringify(j.message?.content).match(/P\d[^"\\]*|答[^"\\]*/)?.[0];
    console.log(`  ${j.type} ${j.uuid?.slice(0, 8)} parent=${j.parentUuid?.slice(0, 8)} ${txt}`);
  }
}
gw.close();
