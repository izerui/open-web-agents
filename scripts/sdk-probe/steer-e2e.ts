// 运行中途追加消息 —— 生产代码(ClaudeSdkEngine + ChannelSteerInbox + steerRun)+ 真实 SDK 子进程 + 假模型。
//
// A 插进当前这一轮:模型正在跑一个慢工具时追加 → 送达;只有一条 result;下一次模型请求里带着它
// B 本轮回答之后再答一轮:模型正在写最终回答时追加 → 送达;两条 result,结局取第二轮,
//   美元取最后的累计值、token 按轮累加
// C 运行结束后再追加 → not_accepting
//
// 跑法:npx tsx --tsconfig tsconfig.json scripts/sdk-probe/steer-e2e.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClaudeSdkEngine } from "@/lib/modules/agent-engine/adapters/claude-sdk/default-engine";
import { buildSpec } from "@/lib/modules/agent/domain/build-spec";
import { InMemorySteerChannel } from "@/lib/modules/run/adapters/in-memory-steer-channel";
import { steerRun } from "@/lib/modules/run/application/steer";
import { ChannelSteerInbox } from "@/lib/modules/run/application/steer-inbox";
import type { AgentEvent, RunContext } from "@/lib/shared";
// @ts-expect-error 探针脚本是 .mjs
import { startFakeGateway } from "./fake-gateway.mjs";

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✅" : "❌"} ${what}`);
  if (!ok) failures.push(what);
};

async function scenario(
  name: string,
  script: unknown[],
  trigger: { onEvent?: (e: AgentEvent, fire: () => void) => void; atMs?: number },
) {
  const gw = await startFakeGateway(script);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "owa-steer-"));
  const workspaceDir = path.join(dataDir, "workspaces", "s1");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const engine = createClaudeSdkEngine(
    dataDir,
    { slots: () => ({ fable: "fake", opus: "fake", sonnet: "fake", haiku: "fake" }) },
    false,
    false,
  );
  const channel = new InMemorySteerChannel();
  const inbox = await ChannelSteerInbox.open(channel, "r1", { pollMs: 50 });
  const ctx: RunContext = {
    sessionId: "s1",
    workspaceDir,
    prompt: "开始",
    unattended: true,
    credentials: { baseUrl: gw.baseUrl, key: "fake-key" },
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } as Record<string, string>,
    steer: inbox ?? undefined,
  };
  const spec = buildSpec(
    { systemPrompt: "p", model: "sonnet", maxTurns: 6, permissionMode: "bypassPermissions" },
    ctx,
  );
  const events: AgentEvent[] = [];
  let api: Promise<{ outcome: string }> | undefined;
  const fire = () => {
    api ??= steerRun(
      { channel, newId: () => "m1", outcomeTimeoutMs: 15_000 },
      { runId: "r1", text: "STEER-追加" },
    );
  };
  if (trigger.atMs !== undefined) setTimeout(fire, trigger.atMs);
  const result = await engine.run(
    spec,
    ctx,
    (e) => {
      events.push(e);
      trigger.onEvent?.(e, fire);
    },
    new AbortController().signal,
  );
  const outcome = api ? (await api).outcome : "(没发)";
  const late = await steerRun(
    { channel, newId: () => "m2", outcomeTimeoutMs: 200 },
    { runId: "r1", text: "晚了" },
  );
  gw.close();
  console.log(`\n── ${name}`);
  console.log("结果:", result.status, JSON.stringify(result.summary), result.cost);
  console.log(
    "模型请求数:",
    gw.turns(),
    " 带追加的请求:",
    gw.seenRequests
      .map((r: unknown, i: number) => (JSON.stringify(r).includes("STEER-追加") ? i + 1 : null))
      .filter(Boolean),
  );
  return { result, outcome, late: late.outcome, events, gw };
}

// A
{
  const { result, outcome, late, events, gw } = await scenario(
    "A 插进当前这一轮",
    [
      { tool: { id: "toolu_slow", name: "Bash", input: { command: "sleep 2; echo done" } } },
      { text: "答完(已看到追加)" },
    ],
    {
      onEvent: (e, fire) => {
        if (e.kind === "tool_use") setTimeout(fire, 300);
      },
    },
  );
  check(outcome === "delivered", "A 接口答 delivered");
  check(
    events.some((e) => e.kind === "steer" && e.outcome === "delivered"),
    "A 事件流里有送达的 steer",
  );
  check(
    gw.turns() === 2 && JSON.stringify(gw.seenRequests[1]).includes("STEER-追加"),
    "A 下一次模型请求带着追加",
  );
  check(result.status === "success" && result.summary === "答完(已看到追加)", "A 结局正确");
  check(late === "not_accepting", "C 运行结束后再追加:not_accepting");
}

// B:模型要 2.5 秒才写完第一段回答,1 秒时追加
{
  const { result, outcome, gw } = await scenario(
    "B 本轮回答之后再答一轮",
    [{ text: "第一段回答", delayMs: 2500 }, { text: "回应追加的第二段" }],
    { atMs: 1_000 },
  );
  check(outcome === "delivered", "B 接口答 delivered");
  check(
    gw.turns() === 2 && JSON.stringify(gw.seenRequests[1]).includes("STEER-追加"),
    "B 第二轮请求带着追加",
  );
  check(
    result.status === "success" && result.summary === "回应追加的第二段",
    "B 结局取第二轮(不停在第一条成功结果)",
  );
  // 假网关每轮 usage:input 10、output 5;美元由 SDK 按模型价格累计
  check(result.cost?.input === 20 && result.cost?.output === 10, "B token 按轮累加");
  console.log("B 美元(最后一条的累计值):", result.cost?.usd);
}

console.log(failures.length ? `\n❌ ${failures.length} 项不符` : "\n全部符合");
process.exit(failures.length ? 1 : 0);
