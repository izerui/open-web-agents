// 追加消息落在"模型正在生成最终回答、之后不再调工具"的窗口里:
// 它会变成第二轮(第二条 result)吗?收到第一条 result 就立即结束输入,这条消息会丢吗?
// 以及多条 result 时 total_cost_usd / usage 是本轮的还是累计的。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnv, startFakeGateway } from "./fake-gateway.mjs";

const MODE = process.env.MODE ?? "end-on-first-result"; // 或 "wait"
const gw = await startFakeGateway([
  { text: "第一段回答。", delayMs: 2500 },
  { text: "第二段回答(回应追加消息)。" },
  { text: "多余的第三段。" },
]);
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-cfg-"));
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-ws-"));
const { query } = await import("@anthropic-ai/claude-agent-sdk");
const ac = new AbortController();
setTimeout(() => ac.abort(), 60_000).unref();

const user = (text) => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  session_id: "",
});
const queue = [user("请回答")];
const waiters = [];
async function* input() {
  for (;;) {
    if (queue.length) {
      const m = queue.shift();
      if (m === null) return;
      yield m;
      continue;
    }
    const next = await new Promise((r) => waiters.push(r));
    if (next === null) return;
    yield next;
  }
}
const push = (m) => (waiters.length ? waiters.shift()(m) : queue.push(m));

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = [];
setTimeout(() => {
  log.push(`${ts()} >>> 推入 STEER-LATE(模型还在生成第一段)`);
  push(user("STEER-LATE:再补充一句"));
}, 1200);

let results = 0;
try {
  for await (const m of query({
    prompt: input(),
    options: {
      cwd: wsDir,
      maxTurns: 6,
      abortController: ac,
      settingSources: [],
      env: isolatedEnv(gw.baseUrl, cfgDir),
    },
  })) {
    if (m.type === "result") {
      results++;
      log.push(
        `${ts()} result#${results} ${m.subtype} result=${JSON.stringify(String(m.result ?? ""))} cost=${m.total_cost_usd} usage.in=${m.usage?.input_tokens} out=${m.usage?.output_tokens} turns=${m.num_turns}`,
      );
      if (MODE === "end-on-first-result" && results === 1) {
        log.push(`${ts()} >>> 结束输入`);
        push(null);
      }
      if (MODE === "wait" && results === 2) push(null);
    } else if (m.type === "assistant") {
      log.push(`${ts()} assistant[${(m.message?.content ?? []).map((b) => b.type)}]`);
    }
  }
  log.push(`${ts()} 流结束`);
} catch (e) {
  log.push(`SDK 异常:${String(e.message ?? e).slice(0, 120)}`);
}
console.log(`MODE=${MODE}`);
console.log(log.join("\n"));
gw.seenRequests.forEach((r, i) =>
  console.log(`请求#${i + 1}: 含STEER=${JSON.stringify(r?.messages ?? []).includes("STEER-LATE")}`),
);
if (process.env.DUMP_TRANSCRIPT) {
  const walk = (d) =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(cfgDir).filter((f) => f.endsWith(".jsonl"))) {
    console.log(`\n=== ${path.basename(f)} ===`);
    for (const line of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) {
      const j = JSON.parse(line);
      const c = j.message?.content;
      console.log(
        `${j.type}${j.attachment ? `/${j.attachment.type}` : ""}${j.operation ? `/${j.operation}` : ""} ${
          typeof c === "string"
            ? JSON.stringify(c.slice(0, 50))
            : Array.isArray(c)
              ? c.map((b) => b.type + (b.text ? JSON.stringify(b.text.slice(0, 40)) : "")).join("+")
              : JSON.stringify((j.content ?? j.attachment?.prompt ?? "").slice?.(0, 50) ?? "")
        }${j.isMeta ? " [meta]" : ""}`,
      );
    }
  }
}
gw.close();
