// 回归测试:agent 子进程的环境组装。
//
// 真实缺陷记录 —— 曾经只传 ANTHROPIC_* + HOME,把宿主环境整个替换掉,
// 导致子进程没有 PATH,Bash 里连 `ls` 都是 command not found。
// 环境必须以宿主环境为底、再叠加凭证与 HOME。

import { buildSdkOptions } from "@/lib/modules/agent-engine/adapters/claude-sdk/options";
import type { AgentSpec, RunContext } from "@/lib/shared";
import { describe, expect, it } from "vitest";

const SLOTS = { fable: "m", opus: "m", sonnet: "m", haiku: "m" };

const spec: AgentSpec = {
  systemPrompt: "p",
  model: { alias: "sonnet" },
  limits: {},
};

function ctxWith(env: Record<string, string>): RunContext {
  return {
    sessionId: "s1",
    workspaceDir: "/ws/s1",
    prompt: "go",
    credentials: { baseUrl: "https://gw", key: "sk-x" },
    env,
  };
}

describe("agent 子进程环境", () => {
  const deps = () => ({
    sharedHome: "/data/.agent-home",
    abort: new AbortController(),
    slots: SLOTS,
    sandboxEnabled: false,
  });

  it("PATH 等宿主变量必须透传,否则子进程连 ls 都跑不了", () => {
    const o = buildSdkOptions(
      spec,
      ctxWith({ PATH: "/usr/bin:/bin", LANG: "zh_CN.UTF-8" }),
      deps(),
    );
    const env = o.env as Record<string, string>;
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.LANG).toBe("zh_CN.UTF-8");
  });

  it("凭证覆盖宿主同名变量(防宿主残留 key 抢占)", () => {
    const o = buildSdkOptions(
      spec,
      ctxWith({ ANTHROPIC_API_KEY: "sk-host-leftover", PATH: "/bin" }),
      deps(),
    );
    expect((o.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("sk-x");
  });

  it("HOME 被覆盖为共享目录(容器里宿主 HOME 常不可写)", () => {
    const o = buildSdkOptions(spec, ctxWith({ HOME: "/nonexistent", PATH: "/bin" }), deps());
    expect((o.env as Record<string, string>).HOME).toBe("/data/.agent-home");
  });

  it("cwd 必须锁在会话工作目录,保证工作空间隔离", () => {
    expect(buildSdkOptions(spec, ctxWith({ PATH: "/bin" }), deps()).cwd).toBe("/ws/s1");
  });
});
