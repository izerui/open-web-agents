import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { InMemoryAgentVersionRepo } from "@/lib/modules/agent/adapters/in-memory-agent-version-repo";
import { UNGATED } from "@/lib/modules/agent/application/__tests__/ungated";
import {
  AgentReleases,
  NothingToPublish,
  VersionNotFound,
} from "@/lib/modules/agent/application/releases";
import { parseVersion, stableStringify } from "@/lib/modules/agent/domain/release";
import type { Agent } from "@/lib/modules/agent/ports";
import { describe, expect, it } from "vitest";

const seed: Agent = {
  id: "a1",
  ownerId: "u1",
  name: "视频",
  webhookUrl: "https://hook.example.com/x",
  config: { systemPrompt: "v1", model: "sonnet" },
};

async function setup() {
  const agents = new InMemoryAgentRepo([seed]);
  const releases = new AgentReleases(agents, new InMemoryAgentVersionRepo(agents), UNGATED);
  const get = async () => {
    const a = await agents.get("a1");
    if (!a) throw new Error("missing");
    return a;
  };
  return { agents, releases, get };
}

describe("AgentReleases", () => {
  it("从未发布:跑草稿,没有'未发布修改'一说", async () => {
    const { releases, get } = await setup();
    const a = await get();
    expect(await releases.resolve(a)).toMatchObject({ version: null, config: seed.config });
    expect(releases.hasUnpublishedChanges(a)).toBe(false);
  });

  it("发布后改草稿:默认仍跑已发布版本,并能看出草稿有未发布修改", async () => {
    const { agents, releases, get } = await setup();
    await releases.publish(await get(), "u1", "首版");
    await agents.upsert({ ...(await get()), config: { systemPrompt: "v2", model: "sonnet" } });
    const a = await get();
    expect(releases.hasUnpublishedChanges(a)).toBe(true);
    expect(await releases.resolve(a)).toMatchObject({
      version: 1,
      config: { systemPrompt: "v1" },
    });
  });

  it("草稿与已发布相同:拒绝重复发布", async () => {
    const { releases, get } = await setup();
    await releases.publish(await get(), "u1");
    await expect(releases.publish(await get(), "u1")).rejects.toBeInstanceOf(NothingToPublish);
  });

  it("字段顺序不同但内容相同,不算修改", async () => {
    const { agents, releases, get } = await setup();
    await releases.publish(await get(), "u1");
    await agents.upsert({ ...(await get()), config: { model: "sonnet", systemPrompt: "v1" } });
    expect(releases.hasUnpublishedChanges(await get())).toBe(false);
  });

  it("显式指定版本:存在则用它,不存在报 VersionNotFound", async () => {
    const { agents, releases, get } = await setup();
    await releases.publish(await get(), "u1");
    await agents.upsert({ ...(await get()), config: { systemPrompt: "v2", model: "sonnet" } });
    await releases.publish(await get(), "u1");
    expect((await releases.resolve(await get(), 1)).config.systemPrompt).toBe("v1");
    expect((await releases.resolve(await get())).version).toBe(2);
    await expect(releases.resolve(await get(), 5)).rejects.toBeInstanceOf(VersionNotFound);
  });

  it("回滚:发布指针指回旧版本,默认入口立刻跑旧版", async () => {
    const { agents, releases, get } = await setup();
    await releases.publish(await get(), "u1");
    await agents.upsert({ ...(await get()), config: { systemPrompt: "v2", model: "sonnet" } });
    await releases.publish(await get(), "u1");
    await releases.activate("a1", 1);
    expect((await releases.resolve(await get())).config.systemPrompt).toBe("v1");
    await expect(releases.activate("a1", 9)).rejects.toBeInstanceOf(VersionNotFound);
  });

  it("载入草稿:内容换成那一版,回调地址与已发布指针不变", async () => {
    const { agents, releases, get } = await setup();
    await releases.publish(await get(), "u1");
    await agents.upsert({
      ...(await get()),
      name: "改名了",
      config: { systemPrompt: "v2", model: "sonnet" },
    });
    await releases.publish(await get(), "u1");
    const restored = await releases.restoreToDraft(await get(), 1);
    expect(restored.name).toBe("视频");
    expect(restored.config.systemPrompt).toBe("v1");
    expect(restored.webhookUrl).toBe(seed.webhookUrl);
    expect(restored.publishedVersion).toBe(2);
  });
});

describe("release 领域规则", () => {
  it("stableStringify 与键顺序无关,忽略 undefined", () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: undefined, z: null }] })).toBe(
      stableStringify({ a: [{ z: null, y: 2 }], b: 1 }),
    );
  });

  it("parseVersion:正整数或数字字符串,其余拒绝", () => {
    expect(parseVersion(undefined)).toEqual({ ok: true });
    expect(parseVersion(3)).toEqual({ ok: true, value: 3 });
    expect(parseVersion("12")).toEqual({ ok: true, value: 12 });
    for (const bad of [0, -1, 1.5, "v1", "", true, {}]) expect(parseVersion(bad).ok).toBe(false);
  });

  it("modelsOf:锁定版本的会话取那一版的模型,跟随草稿的取当前草稿;找不到的不给", async () => {
    const { agents, releases, get } = await setup();
    const v1 = await releases.publish(await get(), "u1");
    await agents.upsert({ ...(await get()), config: { systemPrompt: "v2", model: "model-b" } });
    const models = await releases.modelsOf([
      { id: "pinned", agentId: "a1", agentVersion: v1.version },
      { id: "draft", agentId: "a1" },
      { id: "gone-version", agentId: "a1", agentVersion: 99 },
      { id: "gone-agent", agentId: "nope" },
    ]);
    expect(Object.fromEntries(models)).toEqual({ pinned: "sonnet", draft: "model-b" });
  });
});
