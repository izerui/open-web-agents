// 审计日志的端到端回归:操作留痕、可见范围、机密不进日志。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

type AgentRes = { agent?: { id: string } };
type Audit = {
  items?: {
    action: string;
    actor: { type: string; id?: string; label?: string };
    resource: { type: string; id?: string };
    details?: Record<string, unknown>;
  }[];
  nextCursor?: string;
};

const SECRET_PROMPT = "内部口令-ZETA-7731";

describe("审计日志", () => {
  let owner: Client;
  let editor: Client;
  let stranger: Client;
  let ownerEmail = "";
  let editorId = "";
  let agentId = "";
  let keyPlain = "";
  let webhookSecret = "";

  const mine = async (c: Client, q = "") => (await c.get<Audit>(`/api/audit?limit=200${q}`)).body;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("audit-owner");
    editor = await newUser("audit-editor");
    stranger = await newUser("audit-stranger");
    ownerEmail =
      (await owner.get<{ user?: { email: string } }>("/api/auth")).body.user?.email ?? "";
    const ed = (await editor.get<{ user?: { id: string; email: string } }>("/api/auth")).body.user;
    editorId = ed?.id ?? "";

    agentId =
      (
        await owner.post<AgentRes>("/api/agents", {
          name: "审计对象",
          config: { systemPrompt: "v1", model: "sonnet" },
        })
      ).body.agent?.id ?? "";
    await owner.post("/api/agents", {
      id: agentId,
      name: "审计对象",
      config: { systemPrompt: SECRET_PROMPT, model: "sonnet" },
    });
    await owner.post(`/api/agents/${agentId}/versions`, { note: "首版" });
    await owner.post(`/api/agents/${agentId}/share`, { target: ed?.email, permission: "write" });
    // 协作者改了所有者的智能体
    await editor.post("/api/agents", {
      id: agentId,
      name: "审计对象",
      config: { systemPrompt: "协作者改的", model: "sonnet", maxTurns: 7 },
    });
    const k = await owner.post<{ plaintext?: string; key?: { id: string } }>("/api/keys", {
      name: "审计用",
      agentId,
    });
    keyPlain = k.body.plaintext ?? "";
    await owner.del(`/api/keys?id=${k.body.key?.id}`);
    webhookSecret =
      (await owner.post<{ secret?: string }>("/api/me/webhook-secret", {})).body.secret ?? "";
    // 有人试图登录所有者的账号 —— 必须是 401;曾经在"服务第一个请求是页面"时变成 500
    const attempt = await new Client("attacker").post("/api/auth", {
      action: "login",
      email: ownerEmail,
      password: "wrong-password",
    });
    expect(attempt.status).toBe(401);
  });

  it("所有者看得到自己名下资源上的操作,包括协作者的修改与失败的登录", async () => {
    const items = (await mine(owner)).items ?? [];
    const actions = items.map((e) => e.action);
    for (const a of [
      "agent.create",
      "agent.update",
      "agent.publish",
      "agent.share",
      "api_key.issue",
      "api_key.revoke",
      "me.webhook_secret_set",
      "auth.login_failed",
      "auth.register",
    ]) {
      expect(actions).toContain(a);
    }
    const byEditor = items.find((e) => e.action === "agent.update" && e.actor.id === editorId);
    expect(byEditor?.details?.changed).toEqual(["maxTurns", "systemPrompt"]);
    const failed = items.find((e) => e.action === "auth.login_failed");
    expect(failed?.actor.type).toBe("anonymous");
  });

  it("机密不进日志:Key 明文、提示词内容、回调签名密钥、尝试的密码都不出现", async () => {
    const all = JSON.stringify(await mine(owner));
    expect(keyPlain).toBeTruthy();
    expect(all).not.toContain(keyPlain);
    expect(all).not.toContain(SECRET_PROMPT);
    expect(webhookSecret).toBeTruthy();
    expect(all).not.toContain(webhookSecret);
    expect(all).not.toContain("wrong-password");
  });

  it("协作者看得到自己做的修改;无关的人看不到任何相关记录", async () => {
    const forEditor = (await mine(editor, `&resourceId=${agentId}`)).items ?? [];
    expect(forEditor.some((e) => e.action === "agent.update" && e.actor.id === editorId)).toBe(
      true,
    );
    // 协作者看不到所有者自己的发布等操作 —— 他既不是归属人也不是操作者
    expect(forEditor.some((e) => e.action === "agent.publish")).toBe(false);
    const forStranger = (await mine(stranger, `&resourceId=${agentId}`)).items ?? [];
    expect(forStranger).toEqual([]);
  });

  it("筛选与权限:按动作筛;非管理员不能看全平台;API Key 不能查;未知动作 400", async () => {
    const pub = (await mine(owner, "&action=agent.publish")).items ?? [];
    expect(pub.map((e) => e.details?.note)).toEqual(["首版"]);
    expect((await owner.get("/api/audit?scope=all")).status).toBe(403);
    expect((await owner.get("/api/audit?action=nope")).status).toBe(400);

    const key =
      (await owner.post<{ plaintext?: string }>("/api/keys", { name: "q", agentId })).body
        .plaintext ?? "";
    const byKey = await new Client("k").get("/api/audit", { "X-Api-Key": key });
    expect([401, 403]).toContain(byKey.status);
    expect((await new Client("anon").get("/api/audit")).status).toBe(401);
  });
});
