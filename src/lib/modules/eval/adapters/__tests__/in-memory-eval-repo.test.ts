import { describe, expect, it } from "vitest";
import { InMemoryEvalRepo } from "../in-memory-eval-repo";

describe("InMemoryEvalRepo:用例来源", () => {
  it("不给来源默认 manual;trial 原样保留;改用例不动来源", async () => {
    const repo = new InMemoryEvalRepo();
    const a = await repo.createCase({
      id: "c1",
      agentId: "a",
      name: "x",
      input: "1",
      assertions: {},
    });
    expect(a.source).toBe("manual");
    await repo.createCase({
      id: "c2",
      agentId: "a",
      name: "y",
      input: "2",
      assertions: {},
      source: "trial",
    });
    await repo.updateCase("c2", { name: "y2", input: "3", assertions: {} });
    expect((await repo.listCases("a")).map((c) => [c.id, c.source])).toEqual([
      ["c1", "manual"],
      ["c2", "trial"],
    ]);
  });
});
