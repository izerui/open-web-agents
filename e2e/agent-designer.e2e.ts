// "AI 智能体设计师"的设计 → 应用闭环。
//
// 不调用模型:测试自己扮演设计师,把智能体包文件写进设计会话的工作目录,
// 断言的是平台这一侧 —— 导出、校验、创建/更新、权限、不能借包改动的字段。

import { beforeAll, describe, expect, it } from "vitest";
import { BASE, type Client, newUser, serverUp } from "./client";

type ApplyRes = {
  agent?: { id: string; name: string };
  created?: boolean;
  error?: string;
  code?: string;
  issues?: { field: string; message: string }[];
};
type AgentList = {
  agents?: {
    id: string;
    name: string;
    webhookUrl?: string;
    config: { systemPrompt: string; skillPackages?: { name: string; description: string }[] };
  }[];
};

/** 扮演设计师:把文件写进设计会话的工作目录。 */
async function writeFiles(c: Client, sessionId: string, files: Record<string, string>) {
  const form = new FormData();
  for (const [name, content] of Object.entries(files)) {
    form.append("files", new File([content], name, { type: "text/plain" }));
  }
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/files?overwrite=1`, {
    method: "POST",
    headers: { Cookie: c.cookieHeader() },
    body: form,
  });
  expect(res.status).toBeLessThan(300);
}

const bundle = (name: string, prompt: string) => ({
  "agent/agent.json": JSON.stringify({
    name,
    description: "把数学推导做成讲解视频",
    model: "sonnet",
    maxTurns: 40,
    starters: ["推导基本不等式"],
  }),
  "agent/system-prompt.md": prompt,
  "agent/skills/manim-scene/SKILL.md":
    '---\ndescription: "需要把推导做成动画时使用"\n---\n\n# 步骤\n1. 写 scene.py\n2. 渲染',
  "agent/skills/manim-scene/scripts/render.sh": "manim -qm scene.py",
});

describe("AI 智能体设计师", () => {
  let user: Client;
  let other: Client;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    user = await newUser("designer");
    other = await newUser("designer-other");
  });

  it("从零设计:空定义应用会被拒并列出问题;写好后应用即创建,技能一起带上", async () => {
    const start = await user.post<{ sessionId?: string }>("/api/agents/design", {});
    expect(start.status).toBe(201);
    const sessionId = start.body.sessionId ?? "";

    const empty = await user.post<ApplyRes>("/api/agents/design/apply", { sessionId });
    expect(empty.status).toBe(400);
    expect((empty.body.issues ?? []).length).toBeGreaterThan(0);

    await writeFiles(user, sessionId, bundle("数学视频", "你是数学动画导演"));
    const ok = await user.post<ApplyRes>("/api/agents/design/apply", { sessionId });
    expect(ok.status).toBe(200);
    expect(ok.body.created).toBe(true);
    const id = ok.body.agent?.id ?? "";

    const list = await user.get<AgentList>("/api/agents");
    const a = (list.body.agents ?? []).find((x) => x.id === id);
    expect(a?.name).toBe("数学视频");
    expect(a?.config.skillPackages?.[0]).toMatchObject({
      name: "manim-scene",
      description: "需要把推导做成动画时使用",
    });

    // 继续改再应用:更新同一个智能体,不会再建一个
    await writeFiles(user, sessionId, { "agent/system-prompt.md": "你是更严谨的数学动画导演" });
    const again = await user.post<ApplyRes>("/api/agents/design/apply", { sessionId });
    expect(again.body).toMatchObject({ created: false, agent: { id } });
    const after = (await user.get<AgentList>("/api/agents")).body.agents?.find((x) => x.id === id);
    expect(after?.config.systemPrompt).toBe("你是更严谨的数学动画导演");
  });

  it("修改已有智能体:当前定义先导出到工作目录;回调地址等不在包里的字段沿用原值", async () => {
    const created = await user.post<{ agent?: { id: string } }>("/api/agents", {
      name: "旧智能体",
      webhookUrl: "https://hooks.example.com/x",
      config: { systemPrompt: "旧提示词", model: "sonnet" },
    });
    const id = created.body.agent?.id ?? "";
    const start = await user.post<{ sessionId?: string }>("/api/agents/design", { agentId: id });
    const sessionId = start.body.sessionId ?? "";

    const exported = await user.get(
      `/api/sessions/${sessionId}/files?file=${encodeURIComponent("agent/system-prompt.md")}`,
    );
    expect(JSON.stringify(exported.body)).toContain("旧提示词");

    await writeFiles(user, sessionId, { "agent/system-prompt.md": "新提示词" });
    const r = await user.post<ApplyRes>("/api/agents/design/apply", { sessionId });
    expect(r.body).toMatchObject({ created: false, agent: { id } });
    const a = (await user.get<AgentList>("/api/agents")).body.agents?.find((x) => x.id === id);
    expect(a?.config.systemPrompt).toBe("新提示词");
    expect(a?.webhookUrl).toBe("https://hooks.example.com/x");
  });

  it("不能借智能体包设置回调地址等受保护字段", async () => {
    const start = await user.post<{ sessionId?: string }>("/api/agents/design", {});
    const sessionId = start.body.sessionId ?? "";
    await writeFiles(user, sessionId, {
      "agent/agent.json": JSON.stringify({ name: "x", webhookUrl: "https://attacker.example" }),
      "agent/system-prompt.md": "p",
    });
    const r = await user.post<ApplyRes>("/api/agents/design/apply", { sessionId });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body.issues)).toContain("webhookUrl");
  });

  it("别人的智能体不能拿来设计,别人的设计会话也不能替他应用", async () => {
    const theirs = await other.post<{ agent?: { id: string } }>("/api/agents", {
      name: "别人的",
      config: { systemPrompt: "p", model: "sonnet" },
    });
    const r = await user.post("/api/agents/design", { agentId: theirs.body.agent?.id });
    expect(r.status).toBe(404);

    const otherSession = await other.post<{ sessionId?: string }>("/api/agents/design", {});
    const steal = await user.post("/api/agents/design/apply", {
      sessionId: otherSession.body.sessionId,
    });
    expect(steal.status).toBe(403);
  });

  it("普通会话不能当设计会话应用", async () => {
    const agents = (await user.get<AgentList>("/api/agents")).body.agents ?? [];
    const s = await user.post<{ session?: { id: string } }>("/api/sessions", {
      agentId: agents[0]?.id,
    });
    const r = await user.post<ApplyRes>("/api/agents/design/apply", {
      sessionId: s.body.session?.id,
    });
    expect(r.status).toBe(400);
  });
});
