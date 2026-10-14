// 接口调用方用同一把 API Key 读取任务的工作目录、订阅任务的事件流;别的 Key 一律被拒。
//
// invoke 返回 taskId 与 sessionId,而会话的文件与事件接口都接受 API Key(按会话的 callerApiKeyId
// 认人)—— 这条用例把这条链路从 HTTP 串起来,接入文档与示例据此编写。
// e2e 屏蔽了模型,智能体不会真的产出文件:用同一把 Key 上传一份当作"工作目录里的产物"。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";

describe("接口调用方读取产物与过程(同一把 Key)", () => {
  let owner: Client;
  let agentId = "";
  let keyA = "";
  let keyB = "";
  let otherUserKey = "";
  let taskId = "";
  let sessionId = "";
  const anon = new Client("anon-art");
  const NAME = "report.md";
  const CONTENT = "# 报告\n\n产物内容 ✓\n";

  const raw = (path: string, key?: string, init: RequestInit = {}) =>
    fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(key ? { "X-Api-Key": key } : {}) },
    });

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("art");
    agentId =
      (
        await owner.post<{ agent?: { id: string } }>("/api/agents", {
          name: `art-${Date.now()}`,
          config: { systemPrompt: "p", model: "sonnet" },
        })
      ).body.agent?.id ?? "";
    const issue = async (c: Client, name: string, bind = true) =>
      (await c.post<{ plaintext?: string }>("/api/keys", { name, ...(bind ? { agentId } : {}) }))
        .body.plaintext ?? "";
    keyA = await issue(owner, "a");
    keyB = await issue(owner, "b"); // 同一个账号的另一把 Key
    otherUserKey = await issue(await newUser("art-x"), "x", false);

    const r = await anon.post<{ taskId?: string; sessionId?: string }>(
      `/api/agents/${agentId}/invoke`,
      { input: "生成一份报告" },
      { "X-Api-Key": keyA },
    );
    expect(r.status).toBe(202);
    taskId = r.body.taskId ?? "";
    sessionId = r.body.sessionId ?? "";
    expect(taskId && sessionId).toBeTruthy();

    // 等任务结束(e2e 里很快以失败收尾)
    for (let i = 0; i < 60; i++) {
      const s = await anon.get<{ done?: boolean }>(`/api/agents/${taskId}/result`, {
        "X-Api-Key": keyA,
      });
      if (s.body.done) break;
      await new Promise((ok) => setTimeout(ok, 300));
    }

    const form = new FormData();
    form.append("files", new Blob([CONTENT], { type: "text/markdown" }), NAME);
    const up = await raw(`/api/sessions/${sessionId}/files`, keyA, { method: "POST", body: form });
    expect(up.status).toBe(200);
  });

  it("同一把 Key:列出工作目录、下载产物(字节一致)", async () => {
    const list = await raw(`/api/sessions/${sessionId}/files`, keyA);
    expect(list.status).toBe(200);
    const nodes = ((await list.json()) as { nodes?: { name: string }[] }).nodes ?? [];
    expect(nodes.map((n) => n.name)).toContain(NAME);

    const dl = await raw(
      `/api/sessions/${sessionId}/files?download=${encodeURIComponent(NAME)}`,
      keyA,
    );
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toMatch(/attachment/);
    expect(await dl.text()).toBe(CONTENT);
  });

  it(
    "同一把 Key:按 taskId 订阅事件流,收到这次任务的终态事件后流结束",
    { timeout: 30_000 },
    async () => {
      const res = await raw(
        `/api/sessions/${sessionId}/events?runId=${encodeURIComponent(taskId)}`,
        keyA,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      const text = await res.text(); // 终态之后服务端关流,text() 才会返回
      const events = text
        .split("\n\n")
        .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
        .filter((l): l is string => Boolean(l))
        .map((l) => JSON.parse(l.slice(6)) as { kind: string; runId?: string });
      const result = events.find((e) => e.kind === "result");
      expect(result).toBeDefined();
      expect(result?.runId ?? taskId).toBe(taskId);
    },
  );

  it("同账号的另一把 Key、别的账号的 Key:文件、下载、事件、上传一律拒绝;不带 Key 401", async () => {
    const paths = [
      `/api/sessions/${sessionId}/files`,
      `/api/sessions/${sessionId}/files?download=${encodeURIComponent(NAME)}`,
      `/api/sessions/${sessionId}/events?runId=${encodeURIComponent(taskId)}`,
    ];
    for (const key of [keyB, otherUserKey]) {
      for (const p of paths) {
        const r = await raw(p, key);
        expect([403, 404], `${p}`).toContain(r.status);
        await r.body?.cancel();
      }
      const form = new FormData();
      form.append("files", new Blob(["x"]), "intrude.txt");
      const up = await raw(`/api/sessions/${sessionId}/files`, key, { method: "POST", body: form });
      expect([403, 404]).toContain(up.status);
    }
    for (const p of paths) {
      const r = await raw(p);
      expect(r.status, p).toBe(401);
      await r.body?.cancel();
    }
  });
});
