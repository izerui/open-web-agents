// 软删除智能体的端到端回归:删除后调用、Key、会话、版本都当它不存在;历史与审计保留;id 不可复用。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

type AgentRes = { agent?: { id: string } };

describe("删除智能体(软删除)", () => {
  let owner: Client;
  let editor: Client;
  let stranger: Client;
  const anon = new Client("anon-del");

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("del-owner");
    editor = await newUser("del-editor");
    stranger = await newUser("del-stranger");
  });

  const mk = async (name: string) =>
    (
      await owner.post<AgentRes>("/api/agents", {
        name: `${name}-${Date.now()}`,
        config: { systemPrompt: "p", model: "sonnet" },
      })
    ).body.agent?.id ?? "";

  it("权限:被分享 write 的协作者不能删;无关的人 404;API Key 不能删", async () => {
    const id = await mk("del-perm");
    const editorEmail = (await editor.get<{ user?: { email: string } }>("/api/auth")).body.user
      ?.email;
    await owner.post(`/api/agents/${id}/share`, { target: editorEmail, permission: "write" });
    expect((await editor.del(`/api/agents/${id}`)).status).toBe(403);
    expect((await stranger.del(`/api/agents/${id}`)).status).toBe(404);
    const key =
      (await owner.post<{ plaintext?: string }>("/api/keys", { name: "d", agentId: id })).body
        .plaintext ?? "";
    expect([401, 403]).toContain(
      (await anon.del(`/api/agents/${id}`, { "X-Api-Key": key })).status,
    );
    // 都没删掉
    expect(
      (await owner.get<{ agents?: { id: string }[] }>("/api/agents")).body.agents?.some(
        (a) => a.id === id,
      ),
    ).toBe(true);
  });

  it("删除后:列表、调用、版本、会话里继续运行都当它不存在;历史运行记录与审计保留", async () => {
    const id = await mk("del-main");
    const key =
      (await owner.post<{ plaintext?: string }>("/api/keys", { name: "d", agentId: id })).body
        .plaintext ?? "";
    // 删除前留下一次运行与一个网页会话
    const task = (
      await anon.post<{ taskId?: string }>(
        `/api/agents/${id}/invoke`,
        { input: "hi" },
        {
          "X-Api-Key": key,
        },
      )
    ).body.taskId;
    const session = (
      await owner.post<{ session?: { id: string } }>("/api/sessions", { agentId: id })
    ).body.session;

    const d = await owner.del(`/api/agents/${id}`);
    expect(d.status).toBe(200);
    expect((await owner.del(`/api/agents/${id}`)).status).toBe(404); // 再删:已不存在

    expect(
      (await owner.get<{ agents?: { id: string }[] }>("/api/agents")).body.agents?.some(
        (a) => a.id === id,
      ),
    ).toBe(false);
    expect([401, 403, 404]).toContain(
      (await anon.post(`/api/agents/${id}/invoke`, { input: "hi" }, { "X-Api-Key": key })).status,
    );
    expect((await owner.get(`/api/agents/${id}/versions`)).status).toBe(404);
    expect([403, 404]).toContain(
      (await owner.post(`/api/sessions/${session?.id}/run`, { prompt: "继续", stream: false }))
        .status,
    );

    // 历史保留:运行记录仍在、仍显示名称
    const runs = await owner.get<{ items?: { id: string; agentName?: string }[] }>("/api/runs");
    const r = runs.body.items?.find((x) => x.id === task);
    expect(r).toBeTruthy();
    expect(r?.agentName).toMatch(/^del-main-/);
    // 审计
    const audit = await owner.get<{ items?: { action: string; resource: { id?: string } }[] }>(
      "/api/audit?action=agent.delete",
    );
    expect(audit.body.items?.some((e) => e.resource.id === id)).toBe(true);
  });

  it("已删除智能体的 id 不能被新建复用:409", async () => {
    const id = await mk("del-reuse");
    await owner.del(`/api/agents/${id}`);
    const again = await owner.post<{ error?: string }>("/api/agents", {
      id,
      name: "想复用",
      config: { systemPrompt: "p", model: "sonnet" },
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/已被使用/);
  });

  it("内置智能体:普通用户删不了(不是所有者)", async () => {
    expect((await owner.del("/api/agents/default")).status).toBe(403);
  });
});
