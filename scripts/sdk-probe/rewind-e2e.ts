// "从某一轮重来"—— 生产代码(ClaudeSdkEngine + anchorForBranch + JsonlTranscript)+ 真实 SDK + 假模型。
//
// 主线 P1 → P2 → P3(同一个 SDK 会话、同一份 transcript)。
// A 重来第 3 轮(换成 P3-改写):模型看到 P1、P2、P3-改写,看不到原来的 P3;分到了新会话
// B 分支之后接着聊 P4:续接分支,模型看到 P1、P2、P3-改写、P4,仍看不到 P3
// C 原对话不受影响:按第 3 轮自己的范围回放,仍是原来的回答
// D 重来第 2 轮:模型只看到 P1 与 P2-改写
//
// 跑法:npx tsx --tsconfig tsconfig.json scripts/sdk-probe/rewind-e2e.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClaudeSdkEngine } from "@/lib/modules/agent-engine/adapters/claude-sdk/default-engine";
import { JsonlTranscript } from "@/lib/modules/agent-engine/adapters/claude-sdk/jsonl-transcript";
import type { RunResult } from "@/lib/modules/agent-engine/ports";
import { buildSpec } from "@/lib/modules/agent/domain/build-spec";
import { type RunAnchor, anchorForBranch } from "@/lib/modules/run/domain/branching";
import type { AgentEvent, RunContext } from "@/lib/shared";
// @ts-expect-error 探针脚本是 .mjs
import { startFakeGateway } from "./fake-gateway.mjs";

const gw = await startFakeGateway([
  { text: "答P1" },
  { text: "答P2" },
  { text: "答P3" },
  { text: "答P3-改写" },
  { text: "答P4" },
  { text: "答P2-改写" },
]);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-rw-"));
const workspaceDir = path.join(dataDir, "workspaces", "s1");
fs.mkdirSync(workspaceDir, { recursive: true });
const engine = createClaudeSdkEngine(
  dataDir,
  { slots: () => ({ fable: "fake", opus: "fake", sonnet: "fake", haiku: "fake" }) },
  false,
  false,
);
const run = async (prompt: string, resumeSessionId?: string, resumeSessionAt?: string) => {
  const ctx: RunContext = {
    sessionId: "s1",
    workspaceDir,
    prompt,
    resumeSessionId,
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    unattended: true,
    credentials: { baseUrl: gw.baseUrl, key: "fake-key" },
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } as Record<string, string>,
  };
  const spec = buildSpec({ systemPrompt: "p", model: "sonnet", maxTurns: 2 }, ctx);
  return engine.run(spec, ctx, () => {}, new AbortController().signal);
};
const seenPrompts = () =>
  (JSON.stringify(gw.seenRequests.at(-1)?.messages ?? []).match(/P\d(-改写)?/g) ?? []).filter(
    (v: string, i: number, a: string[]) => a.indexOf(v) === i,
  );
const row = (id: string, r: RunResult, n: number, resumeAnchor?: string): RunAnchor => ({
  id,
  resumeAnchor,
  sdkSessionId: r.sessionId,
  transcriptRange: r.transcriptRange,
  createdAt: n,
});
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✅" : "❌"} ${what}`);
  if (!ok) failures.push(what);
};

const r1 = await run("P1");
const r2 = await run("P2", r1.sessionId);
const r3 = await run("P3", r2.sessionId);
const S = r1.sessionId;
check(r2.sessionId === S && r3.sessionId === S, "主线三轮是同一个 SDK 会话");
const rows = [row("r1", r1, 1), row("r2", r2, 2, S), row("r3", r3, 3, S)];

// A
const a = anchorForBranch(rows[2] as RunAnchor, "rewind", rows);
if (!a.ok) throw new Error(a.reason);
const b = await run("P3-改写", a.resumeAnchor, a.resumeAt);
check(
  JSON.stringify(seenPrompts()) === JSON.stringify(["P1", "P2", "P3-改写"]),
  `A 重来第 3 轮,模型看到 ${seenPrompts().join(",")}`,
);
check(b.sessionId !== S, "A 分到了新会话");

// B
await run("P4", b.sessionId);
check(
  JSON.stringify(seenPrompts()) === JSON.stringify(["P1", "P2", "P3-改写", "P4"]),
  `B 分支后接着聊,模型看到 ${seenPrompts().join(",")}`,
);

// C
const t = new JsonlTranscript();
const texts = (es: AgentEvent[]) => es.flatMap((e) => (e.kind === "text" ? [e.text] : []));
const r3History = await t.read({
  dataDir,
  workspaceDir,
  sdkSessionId: S ?? "",
  range: r3.transcriptRange,
});
check(
  JSON.stringify(texts(r3History)) === JSON.stringify(["答P3"]),
  `C 原第 3 轮的回放仍是 ${texts(r3History).join(",")}`,
);

// D
const d = anchorForBranch(rows[1] as RunAnchor, "rewind", rows);
if (!d.ok) throw new Error(d.reason);
await run("P2-改写", d.resumeAnchor, d.resumeAt);
check(
  JSON.stringify(seenPrompts()) === JSON.stringify(["P1", "P2-改写"]),
  `D 重来第 2 轮,模型看到 ${seenPrompts().join(",")}`,
);

gw.close();
console.log(failures.length ? `\n❌ ${failures.length} 项不符` : "\n全部符合");
process.exit(failures.length ? 1 : 0);
