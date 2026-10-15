// 用真实 SDK + 本地模拟网关核对追加消息的多 result 用量语义,不调用付费模型。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { isolatedEnv, startFakeGateway } from "./fake-gateway.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "owa-metering-probe-"));
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 45_000);
const queue = [];
const waiters = [];
const user = (text) => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  session_id: "",
});
const push = (message) => (waiters.length ? waiters.shift()(message) : queue.push(message));
push(user("METERING-FIRST"));
async function* prompts() {
  for (;;) {
    const next = queue.length
      ? queue.shift()
      : await new Promise((resolve) => waiters.push(resolve));
    if (next === null) return;
    yield next;
  }
}

let mainCalls = 0;
let gateway;
const script = new Proxy([], {
  get(_target, key) {
    if (!/^\d+$/.test(String(key))) return undefined;
    const request = gateway.seenRequests.at(-1);
    // SDK 的标题辅助请求没有工具,不计入主对话剧本。
    if (!request?.tools?.length) return { text: "计量测试" };
    mainCalls++;
    if (mainCalls === 1) {
      setTimeout(() => push(user("METERING-SECOND")), 100);
      return { text: "第一段", delayMs: 800 };
    }
    return { text: "第二段" };
  },
});
gateway = await startFakeGateway(script);
const results = [];
try {
  for await (const message of query({
    prompt: prompts(),
    options: {
      cwd: root,
      settingSources: [],
      maxTurns: 6,
      abortController: abort,
      env: isolatedEnv(gateway.baseUrl, path.join(root, ".claude")),
    },
  })) {
    if (message.type === "result") {
      results.push({
        usage: message.usage,
        modelUsage: message.modelUsage,
        usd: message.total_cost_usd,
      });
      if (results.length === 1) push(null);
    }
  }
  assert.equal(results.length, 2, "追加消息必须产生两条结果");
  const before = results[0].modelUsage;
  const after = results[1].modelUsage;
  assert.ok(before && after && Object.keys(before).length > 0, "SDK 必须给出模型明细");
  let increased = false;
  for (const [model, usage] of Object.entries(before)) {
    assert.ok(after[model].inputTokens >= usage.inputTokens, "后续结果保留前面的输入用量");
    assert.ok(after[model].outputTokens >= usage.outputTokens, "后续结果保留前面的输出用量");
    increased ||= after[model].inputTokens > usage.inputTokens;
  }
  assert.ok(increased, "后续模型快照包含追加调用的用量");
  console.log(JSON.stringify({ mainCalls, results }, null, 2));
} finally {
  clearTimeout(timer);
  abort.abort();
  gateway.close();
  fs.rmSync(root, { recursive: true, force: true });
}
