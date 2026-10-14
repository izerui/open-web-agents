// 历史回放按本轮 uuid 范围截取 —— 用【生产代码】+ 真实 SDK 子进程 + 假模型验证。
//
// 背景:resume 同一个 SDK 会话不换 session id,各轮写进同一份 jsonl(见 README「已验证的结论」)。
// 判据:两轮续接后,用各自记下的 transcriptRange 读,第 1 轮只看到"答一",第 2 轮只看到"答二";
// 不给范围(旧行为)则两轮都看到全部。
//
// 跑法:npx tsx scripts/sdk-probe/history-slice.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClaudeSdkEngine } from "@/lib/modules/agent-engine/adapters/claude-sdk/default-engine";
import { JsonlTranscript } from "@/lib/modules/agent-engine/adapters/claude-sdk/jsonl-transcript";
import { buildSpec } from "@/lib/modules/agent/domain/build-spec";
import type { AgentEvent, RunContext } from "@/lib/shared";
// @ts-expect-error 探针脚本是 .mjs
import { startFakeGateway } from "./fake-gateway.mjs";

const gw = await startFakeGateway([
  { tool: { id: "toolu_1", name: "Bash", input: { command: "echo one" } } },
  { text: "答一" },
  { text: "答二" },
]);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-hist-"));
const workspaceDir = path.join(dataDir, "workspaces", "s1");
fs.mkdirSync(workspaceDir, { recursive: true });

const engine = createClaudeSdkEngine(
  dataDir,
  { slots: () => ({ fable: "fake", opus: "fake", sonnet: "fake", haiku: "fake" }) },
  false,
  false,
);
const ctx = (prompt: string, resumeSessionId?: string): RunContext => ({
  sessionId: "s1",
  workspaceDir,
  prompt,
  resumeSessionId,
  unattended: true,
  credentials: { baseUrl: gw.baseUrl, key: "fake-key" },
  env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } as Record<string, string>,
});

const spec = (c: RunContext) => buildSpec({ systemPrompt: "p", model: "sonnet", maxTurns: 4 }, c);
const c1 = ctx("第一轮");
const r1 = await engine.run(spec(c1), c1, () => {}, new AbortController().signal);
const c2 = ctx("第二轮", r1.sessionId);
const r2 = await engine.run(spec(c2), c2, () => {}, new AbortController().signal);
gw.close();
console.log(
  "r1",
  r1.status,
  r1.sessionId?.slice(0, 8),
  r1.transcriptRange,
  r1.error?.message ?? "",
);
console.log(
  "r2",
  r2.status,
  r2.sessionId?.slice(0, 8),
  r2.transcriptRange,
  r2.error?.message ?? "",
);
console.log("同一个 SDK 会话:", r1.sessionId === r2.sessionId);

const t = new JsonlTranscript();
const texts = (es: AgentEvent[]) => es.flatMap((e) => (e.kind === "text" ? [e.text] : []));
const read = (sid: string | undefined, range?: { first: string; last: string }) =>
  t.read({ dataDir, workspaceDir, sdkSessionId: sid ?? "", range });
const h1 = await read(r1.sessionId, r1.transcriptRange);
const h2 = await read(r2.sessionId, r2.transcriptRange);
const whole = await read(r1.sessionId);
console.log("第 1 轮(按范围):", texts(h1), h1.map((e) => e.kind).join(","));
console.log("第 2 轮(按范围):", texts(h2), h2.map((e) => e.kind).join(","));
console.log("不给范围(旧行为):", texts(whole));
const ok =
  JSON.stringify(texts(h1)) === JSON.stringify(["答一"]) &&
  JSON.stringify(texts(h2)) === JSON.stringify(["答二"]) &&
  h1.some((e) => e.kind === "tool_use") &&
  !h2.some((e) => e.kind === "tool_use");
console.log(ok ? "✅ 各轮只回放自己的过程" : "❌ 截取不对");
process.exit(ok ? 0 : 1);
