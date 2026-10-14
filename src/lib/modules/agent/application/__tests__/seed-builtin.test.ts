// 内置智能体的启动写入:首次写入、没人改过就升级、有人改过就保留。

import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { seedBuiltin } from "@/lib/modules/agent/application/seed-builtin";
import { decideSeed } from "@/lib/modules/agent/domain/builtin-seed";
import type { Agent } from "@/lib/modules/agent/ports";
import { describe, expect, it } from "vitest";

const V1: Agent = {
  id: "default",
  ownerId: "system",
  name: "通用助手",
  config: { systemPrompt: "v1 提示词", model: "sonnet" },
};
const V2: Agent = { ...V1, config: { systemPrompt: "v2 提示词(代码里改进了)", model: "sonnet" } };

function setup(agents = new InMemoryAgentRepo()) {
  let grants = 0;
  const warnings: string[] = [];
  const deps = {
    agents,
    grantPublicRead: async () => {
      grants++;
    },
    warn: (m: string) => warnings.push(m),
  };
  return { agents, deps, warnings, grants: () => grants };
}

describe("decideSeed", () => {
  it("不存在 → 写入;有摘要:没改过 → 升级,改过 → 保留", () => {
    expect(decideSeed(null, "d")).toBe("insert");
    expect(decideSeed({ contentHash: "a", seedHash: "a" }, "d")).toBe("upgrade");
    expect(decideSeed({ contentHash: "b", seedHash: "a" }, "d")).toBe("keep-modified");
  });

  it("旧数据没有摘要:内容就是代码里的定义 → 只开始跟踪;否则无从判断 → 保留,不当成没人改过", () => {
    expect(decideSeed({ contentHash: "d" }, "d")).toBe("adopt");
    expect(decideSeed({ contentHash: "x" }, "d")).toBe("keep-unknown");
  });
});

describe("seedBuiltin", () => {
  it("首次启动:写入定义并授予公开只读", async () => {
    const t = setup();
    expect(await seedBuiltin(t.deps, V1)).toBe("insert");
    expect((await t.agents.get("default"))?.config.systemPrompt).toBe("v1 提示词");
    expect(t.grants()).toBe(1);
  });

  it("没人改过、代码里的定义更新了:升级;公开授权不重复加", async () => {
    const t = setup();
    await seedBuiltin(t.deps, V1);
    expect(await seedBuiltin(t.deps, V2)).toBe("upgrade");
    expect((await t.agents.get("default"))?.config.systemPrompt).toBe("v2 提示词(代码里改进了)");
    expect(t.grants()).toBe(1);
  });

  it("管理员改过:重启后保留他的修改,并告警", async () => {
    const t = setup();
    await seedBuiltin(t.deps, V1);
    const cur = await t.agents.get("default");
    if (!cur) throw new Error("missing");
    await t.agents.upsert({ ...cur, config: { ...cur.config, systemPrompt: "管理员改的" } });

    expect(await seedBuiltin(t.deps, V2)).toBe("keep-modified");
    expect((await t.agents.get("default"))?.config.systemPrompt).toBe("管理员改的");
    expect(t.warnings[0]).toMatch(/已被修改/);
    // 再重启一次也一样
    expect(await seedBuiltin(t.deps, V2)).toBe("keep-modified");
  });

  it("旧数据没有摘要、管理员改过提示词:装上这次修复后的第一次启动,原样保留并告警", async () => {
    // 修复前部署里的行:没有种子摘要,提示词被管理员改过
    const agents = new InMemoryAgentRepo([
      { ...V1, config: { ...V1.config, systemPrompt: "管理员改过的提示词" } },
    ]);
    const t = setup(agents);
    expect(await seedBuiltin(t.deps, V2)).toBe("keep-unknown");
    expect((await agents.get("default"))?.config.systemPrompt).toBe("管理员改过的提示词");
    expect((await agents.get("default"))?.seedHash).toBeUndefined();
    expect(t.warnings[0]).toMatch(/无从判断/);
    // 之后每次启动都一样,不会哪一次突然覆盖
    expect(await seedBuiltin(t.deps, V2)).toBe("keep-unknown");
    expect((await agents.get("default"))?.config.systemPrompt).toBe("管理员改过的提示词");
    expect(t.grants()).toBe(0);
  });

  it("旧数据没有摘要、内容就是当前内置定义:不写内容,只开始跟踪;之后代码更新就能升级", async () => {
    const agents = new InMemoryAgentRepo([V1]);
    const t = setup(agents);
    expect(await seedBuiltin(t.deps, V1)).toBe("adopt");
    expect((await agents.get("default"))?.seedHash).toBeTruthy();
    expect(await seedBuiltin(t.deps, V2)).toBe("upgrade");
    expect((await agents.get("default"))?.config.systemPrompt).toBe("v2 提示词(代码里改进了)");
  });

  it("旧数据没有摘要、内容是更早的内置定义(没人改过但也无从证明):同样保留,不冒险覆盖", async () => {
    const agents = new InMemoryAgentRepo([V1]);
    const t = setup(agents);
    expect(await seedBuiltin(t.deps, V2)).toBe("keep-unknown");
    expect((await agents.get("default"))?.config.systemPrompt).toBe("v1 提示词");
  });

  it("升级时沿用管理员配的回调地址(运维设置不属于定义)", async () => {
    const t = setup();
    await seedBuiltin(t.deps, V1);
    // 只改回调地址:不算改动定义内容
    const cur = await t.agents.get("default");
    if (!cur) throw new Error("missing");
    await t.agents.upsert({ ...cur, webhookUrl: "https://hook.example.com/in" });
    expect(await seedBuiltin(t.deps, V2)).toBe("upgrade");
    expect((await t.agents.get("default"))?.webhookUrl).toBe("https://hook.example.com/in");
  });

  it("被删除过:不复活", async () => {
    const t = setup();
    await seedBuiltin(t.deps, V1);
    await t.agents.softDelete("default", 1);
    expect(await seedBuiltin(t.deps, V2)).toBe("deleted");
    expect(await t.agents.get("default")).toBeNull();
  });
});
