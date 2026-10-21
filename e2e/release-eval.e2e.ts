// 评测与发布关联 —— 真实服务。发布门槛:草稿须有一次配置相同、用例相同、全部通过的评测,没有例外;
// 回滚不受限。版本列表给能改的人附上草稿与各版本的评测结论,只读者拿不到。
// e2e 屏蔽了模型,运行必然失败:"期望失败"的用例稳定通过,"期望成功"的稳定不通过。

import { beforeAll, describe, expect, it } from "vitest";
import { type Client, newUser, passDraftEval, serverUp } from "./client";

type Brief = { id: string; passed: number; total: number };
type Summary = { state: string; run?: Brief; previous?: Brief };
type VersionsRes = {
  publishedVersion: number | null;
  evals?: { draft: Summary; versions: Record<string, Summary> };
  code?: string;
  error?: string;
};
type RunsRes = {
  runs?: { id: string; matchesDraft: boolean; matchesVersions: number[]; casesChanged: boolean }[];
};

describe("评测与发布关联", { timeout: 60_000 }, () => {
  let owner: Client;
  let reader: Client;
  let agentId = "";
  const save = (systemPrompt: string) =>
    owner.post<{ agent?: { id: string } }>("/api/agents", {
      id: agentId || undefined,
      name: "门槛测试",
      config: { systemPrompt, model: "sonnet" },
    });
  const publish = () =>
    owner.post<{ code?: string; error?: string }>(`/api/agents/${agentId}/versions`, {});
  const versions = (c: Client = owner) => c.get<VersionsRes>(`/api/agents/${agentId}/versions`);
  const cases = () => `/api/agents/${agentId}/evals/cases`;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("rel-eval");
    reader = await newUser("rel-eval-r");
    agentId = (await save("甲")).body.agent?.id ?? "";
    const email = (await reader.get<{ user?: { email: string } }>("/api/auth")).body.user?.email;
    await owner.post(`/api/agents/${agentId}/share`, { target: email, permission: "read" });
  });

  it("没有用例:不能发布(409 eval_required),版本列表标明没有用例", async () => {
    const p = await publish();
    expect(p.status).toBe(409);
    expect(p.body.code).toBe("eval_required");
    expect(p.body.error).toContain("评测用例");
    expect((await versions()).body.evals?.draft.state).toBe("no_cases");
  });

  it("有用例但没评测过、评测没全部通过:都不能发布", async () => {
    await owner.post(cases(), {
      name: "期望失败",
      input: "x",
      assertions: { expectSuccess: false },
    });
    const none = await publish();
    expect(none.status).toBe(409);
    expect(none.body.code).toBe("eval_required");
    expect((await versions()).body.evals?.draft.state).toBe("none");

    // 加一个必然不通过的用例,跑评测:1/2
    const bad = await owner.post<{ case?: { id: string } }>(cases(), {
      name: "期望成功",
      input: "y",
      assertions: { expectSuccess: true },
    });
    const start = await owner.post<{ run?: { id: string } }>(`/api/agents/${agentId}/evals/runs`, {
      target: "draft",
    });
    expect(start.status).toBe(202);
    // 不打开评测详情:版本列表自己顺带判分,不会一直停在"进行中"
    let draft: Summary | undefined;
    for (let i = 0; i < 120; i++) {
      draft = (await versions()).body.evals?.draft;
      if (draft?.state !== "running") break;
      await new Promise((ok) => setTimeout(ok, 250));
    }
    expect(draft).toMatchObject({ state: "failed", run: { passed: 1, total: 2 } });
    const failed = await publish();
    expect(failed.status).toBe(409);
    expect(failed.body.error).toContain("1/2");

    await owner.del(`${cases()}/${bad.body.case?.id}`);
  });

  it("草稿评测全部通过 → 能发布;发布后 v1 的评测结论就是这次评测(按内容关联)", async () => {
    await passDraftEval(owner, agentId);
    const p = await publish();
    expect(p.status).toBe(201);
    const v = await versions();
    expect(v.body.evals?.versions["1"]?.state).toBe("passed");
    expect(v.body.evals?.draft.state).toBe("passed");
    const runs = await owner.get<RunsRes>(`/api/agents/${agentId}/evals/runs`);
    expect(runs.body.runs?.[0]).toMatchObject({
      matchesDraft: true,
      matchesVersions: [1],
      casesChanged: false,
    });
  });

  it("改了草稿:评测对不上,不能发布;带出上次评测;改回原样又对得上", async () => {
    await save("乙");
    const d = (await versions()).body.evals?.draft;
    expect(d?.state).toBe("none");
    // 此时有两个用例:"期望失败"与辅助函数加的"e2e 发布门槛"
    expect(d?.previous).toMatchObject({ passed: 2, total: 2 });
    expect((await publish()).body.code).toBe("eval_required");
    const runs = await owner.get<RunsRes>(`/api/agents/${agentId}/evals/runs`);
    expect(runs.body.runs?.[0]?.matchesDraft).toBe(false);
    expect(runs.body.runs?.[0]?.matchesVersions).toEqual([1]);

    await save("甲");
    expect((await versions()).body.evals?.draft.state).toBe("passed");
  });

  it("评测后改了用例:用例已改动,要重新评测才能发布;重新评测后发布 v2", async () => {
    await save("丙");
    await passDraftEval(owner, agentId);
    const list = await owner.get<{ cases?: { id: string; name: string }[] }>(cases());
    const c = list.body.cases?.find((x) => x.name === "期望失败");
    await owner.put(`${cases()}/${c?.id}`, {
      name: "期望失败",
      input: "改过的输入",
      assertions: { expectSuccess: false },
    });
    const v = await versions();
    expect(v.body.evals?.draft.state).toBe("cases_changed");
    expect(v.body.evals?.versions["1"]?.state).toBe("cases_changed");
    const blocked = await publish();
    expect(blocked.body.code).toBe("eval_required");
    expect(blocked.body.error).toContain("用例有改动");

    await passDraftEval(owner, agentId);
    expect((await publish()).status).toBe(201);
    expect((await versions()).body.publishedVersion).toBe(2);
  });

  it("回滚不受评测限制:v1 的评测已过期,仍能切回 v1", async () => {
    expect((await versions()).body.evals?.versions["1"]?.state).toBe("cases_changed");
    const r = await owner.post(`/api/agents/${agentId}/versions/1/activate`, {});
    expect(r.status).toBe(200);
    expect((await versions()).body.publishedVersion).toBe(1);
  });

  it("只读者看版本列表:没有评测结论", async () => {
    const r = await versions(reader);
    expect(r.status).toBe(200);
    expect(r.body.evals).toBeUndefined();
  });
});
