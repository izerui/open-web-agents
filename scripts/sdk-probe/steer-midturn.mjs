// 运行中途追加消息(流式输入)的真实语义:是插进当前这一轮,还是排成新的一轮?
//
// 剧本:第一条消息让模型调一个慢工具(sleep 3);工具执行期间推第二条消息(STEER-MARKER)。
// 判据看假网关收到的请求:STEER-MARKER 出现在哪一次 /v1/messages 里、SDK 一共产出几条 result。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnv, startFakeGateway } from "./fake-gateway.mjs";

const gw = await startFakeGateway([
  { tool: { id: "toolu_slow", name: "Bash", input: { command: "sleep 3; echo slow-done" } } },
  { text: "第一段回答。" },
  { text: "第二段回答。" },
  { text: "第三段回答。" },
]);
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-cfg-"));
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-ws-"));
const { query } = await import("@anthropic-ai/claude-agent-sdk");
const ac = new AbortController();
setTimeout(() => ac.abort(), 90_000).unref();

const user = (text) => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  session_id: "",
});

// 输入流:先给第一条;工具开始执行后推第二条;收到"足够"的 result 后结束输入
const queue = [user("先执行那条慢命令")];
const waiters = [];
async function* input() {
  for (;;) {
    if (queue.length) {
      yield queue.shift();
      continue;
    }
    const next = await new Promise((r) => waiters.push(r));
    if (next === null) return;
    yield next;
  }
}
const push = (m) => (waiters.length ? waiters.shift()(m) : queue.push(m));
const end = () => (waiters.length ? waiters.shift()(null) : queue.push(null));

const log = [];
let results = 0;
let steered = false;
const t0 = Date.now();
const q = query({
  prompt: input(),
  options: {
    cwd: wsDir,
    maxTurns: 6,
    abortController: ac,
    settingSources: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    env: isolatedEnv(gw.baseUrl, cfgDir),
  },
});
try {
  for await (const m of q) {
    const t = ((Date.now() - t0) / 1000).toFixed(1);
    if (m.type === "assistant") {
      const kinds = (m.message?.content ?? []).map((b) => b.type).join(",");
      log.push(`${t}s assistant[${kinds}]`);
      if (kinds.includes("tool_use") && !steered) {
        steered = true;
        setTimeout(() => {
          log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s >>> 推入 STEER-MARKER`);
          push(user("STEER-MARKER:改成只回答一句话"));
        }, 500);
      }
    } else if (m.type === "user") {
      const kinds = Array.isArray(m.message?.content)
        ? m.message.content.map((b) => b.type).join(",")
        : typeof m.message?.content;
      log.push(`${t}s user[${kinds}]`);
    } else if (m.type === "result") {
      results++;
      log.push(
        `${t}s result#${results} subtype=${m.subtype} result=${JSON.stringify(String(m.result ?? "").slice(0, 30))}`,
      );
      // 推过追加消息、且已拿到至少一条 result 后,再等 4 秒看有没有第二条,然后结束输入
      if (steered && results === 1) setTimeout(end, 4000);
      if (results >= 2) end();
    } else if (m.type === "system") {
      log.push(`${t}s system/${m.subtype}`);
    }
  }
} catch (e) {
  log.push(`SDK 异常:${String(e.message ?? e).slice(0, 120)}`);
}

console.log(log.join("\n"));
console.log("\n网关请求数:", gw.turns());
gw.seenRequests.forEach((r, i) => {
  const msgs = r?.messages ?? [];
  const flat = JSON.stringify(msgs);
  console.log(
    `请求#${i + 1}: messages=${msgs.length} 含STEER=${flat.includes("STEER-MARKER")} 最后一条角色=${msgs.at(-1)?.role} 内容类型=${JSON.stringify((Array.isArray(msgs.at(-1)?.content) ? msgs.at(-1).content : [{ type: "text" }]).map((b) => b.type))}`,
  );
});
if (process.env.DUMP) {
  for (const [i, r] of gw.seenRequests.entries()) {
    console.log(`\n--- 请求#${i + 1} ---`);
    for (const m of r?.messages ?? []) {
      const c = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
      console.log(
        `  ${m.role}: ${c
          .map((b) => `${b.type}${b.text ? `(${JSON.stringify(b.text.slice(0, 70))})` : ""}`)
          .join(" + ")}`,
      );
    }
  }
}
if (process.env.DUMP_TRANSCRIPT) {
  const walk = (d) =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(cfgDir).filter((f) => f.endsWith(".jsonl"))) {
    console.log(`\n=== ${path.basename(f)} ===`);
    for (const line of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) {
      if (line.includes("STEER-MARKER")) console.log(line.slice(0, 900));
    }
  }
}
gw.close();
