// 发布门槛接在 AgentReleases 上:草稿须有一次配置相同、用例相同、全部通过的评测;回滚不受限。
import { InMemoryAgentRepo } from "@/lib/modules/agent/adapters/in-memory-agent-repo";
import { InMemoryAgentVersionRepo } from "@/lib/modules/agent/adapters/in-memory-agent-version-repo";
import { AgentReleases, PublishBlocked } from "@/lib/modules/agent/application/releases";
import { contentHash, snapshotOf } from "@/lib/modules/agent/domain/release";
import type { Agent } from "@/lib/modules/agent/ports";
import { InMemoryEvalRepo } from "@/lib/modules/eval/adapters/in-memory-eval-repo";
import { casesHash } from "@/lib/modules/eval/domain/release-gate";
import type { EvalRun } from "@/lib/modules/eval/ports";
import { describe, expect, it } from "vitest";
import { ReleaseEvals } from "../release-evals";

const seed: Agent = {
  id: "a1",
  ownerId: "u1",
  name: "门槛",
  config: { systemPrompt: "甲", model: "sonnet" },
};

async function setup(settle?: (id: string) => Promise<EvalRun | null>) {
  const agents = new InMemoryAgentRepo([seed]);
  const evals = new InMemoryEvalRepo();
  const gate = new ReleaseEvals(evals, settle);
  const releases = new AgentReleases(agents, new InMemoryAgentVersionRepo(agents), gate);
  const get = async () => (await agents.get("a1")) as Agent;
  let n = 0;
  /** 对当前草稿记一次评测(passed / total),用当前用例的摘要 */
  const evaluate = async (passed: number, total: number, status: EvalRun["status"] = "done") => {
    const a = await get();
    const id = `r${++n}`;
    await evals.createRun(
      {
        id,
        agentId: a.id,
        configHash: contentHash(snapshotOf(a)),
        casesHash: casesHash(await evals.listCases(a.id)) ?? undefined,
        status,
        total,
        passed,
        failed: total - passed,
        startedBy: "u1",
      },
      [],
    );
    return id;
  };
  const addCase = (id: string, input = "x") =>
    evals.createCase({ id, agentId: "a1", name: id, input, assertions: {} });
  return { agents, evals, gate, releases, get, evaluate, addCase };
}

describe("发布门槛", () => {
  it("没有用例、没评测、没全部通过、评测进行中:都拒绝发布", async () => {
    const h = await setup();
    await expect(h.releases.publish(await h.get(), "u1")).rejects.toThrow(/评测用例/);
    await h.addCase("c1");
    await expect(h.releases.publish(await h.get(), "u1")).rejects.toBeInstanceOf(PublishBlocked);
    await h.evaluate(0, 1);
    await expect(h.releases.publish(await h.get(), "u1")).rejects.toThrow(/0\/1/);
    await h.evaluate(1, 1, "running");
    await expect(h.releases.publish(await h.get(), "u1")).rejects.toThrow(/进行中/);
  });

  it("最近一次评测说了算:先通过、后来没通过,不能发布", async () => {
    const h = await setup();
    await h.addCase("c1");
    await h.evaluate(1, 1);
    await h.evaluate(0, 1);
    await expect(h.releases.publish(await h.get(), "u1")).rejects.toThrow(/0\/1/);
  });

  it("全部通过 → 能发布;发布的版本按内容对上这次评测", async () => {
    const h = await setup();
    await h.addCase("c1");
    await h.evaluate(1, 1);
    const v = await h.releases.publish(await h.get(), "u1");
    expect(v.version).toBe(1);
    const verdicts = await h.gate.verdicts("a1", [v.contentHash]);
    expect(verdicts.get(v.contentHash)?.state).toBe("passed");
  });

  it("改草稿后对不上;改回原样又对得上", async () => {
    const h = await setup();
    await h.addCase("c1");
    await h.evaluate(1, 1);
    await h.agents.upsert({ ...(await h.get()), config: { systemPrompt: "乙", model: "sonnet" } });
    await expect(h.releases.publish(await h.get(), "u1")).rejects.toThrow(/还没有评测过/);
    await h.agents.upsert({ ...(await h.get()), config: { systemPrompt: "甲", model: "sonnet" } });
    expect((await h.releases.publish(await h.get(), "u1")).version).toBe(1);
  });

  it("评测后改了用例:拒绝,要重新评测", async () => {
    const h = await setup();
    await h.addCase("c1");
    await h.evaluate(1, 1);
    await h.evals.updateCase("c1", { name: "c1", input: "改了", assertions: {} });
    await expect(h.releases.publish(await h.get(), "u1")).rejects.toThrow(/用例有改动/);
    await h.evaluate(1, 1);
    expect((await h.releases.publish(await h.get(), "u1")).version).toBe(1);
  });

  it("库里还是进行中、其实已能结算的评测:先结算再判定", async () => {
    const box: { evals?: InMemoryEvalRepo } = {};
    const h = await setup(async (id) => {
      await box.evals?.finishRun(id, { passed: 1, failed: 0 });
      return (await box.evals?.getRun(id)) ?? null;
    });
    box.evals = h.evals;
    await h.addCase("c1");
    await h.evaluate(0, 1, "running");
    expect((await h.releases.publish(await h.get(), "u1")).version).toBe(1);
  });

  it("回滚不过门槛:v1 的评测已过期,仍能切回", async () => {
    const h = await setup();
    await h.addCase("c1");
    await h.evaluate(1, 1);
    await h.releases.publish(await h.get(), "u1");
    await h.agents.upsert({ ...(await h.get()), config: { systemPrompt: "乙", model: "sonnet" } });
    await h.evaluate(1, 1);
    await h.releases.publish(await h.get(), "u1");
    await h.addCase("c2");
    await h.releases.activate("a1", 1);
    expect((await h.get()).publishedVersion).toBe(1);
  });
});
