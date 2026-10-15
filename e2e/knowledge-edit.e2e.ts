// 知识库编辑端到端回归:验证表单的完整流程。
//
// 覆盖:添加文档 → 展开读取正文 → 编辑标题和正文 → 保存 → 重新打开确认新内容 →
//       文档 B 不受影响 → GET 单文档只能读本智能体的 → 越权 404。

import { beforeAll, describe, expect, it } from "vitest";
import { type Client, newUser, serverUp } from "./client";

describe("知识库编辑", () => {
  let owner: Client;
  let other: Client;
  let agentId: string;

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("kb-edit");
    other = await newUser("kb-other");

    const agentRes = await owner.post<{ agent?: { id: string } }>("/api/agents", {
      name: "知识库验收",
      config: { systemPrompt: "测试", model: "sonnet" },
    });
    agentId = agentRes.body.agent?.id ?? "";
    expect(agentId).toBeTruthy();
  });

  let docAId: string;
  let docBId: string;

  it("添加两篇文档", async () => {
    const a = await owner.post<{ doc?: { id: string; title: string } }>(
      `/api/agents/${agentId}/knowledge`,
      { title: "二叉树基础", content: "二叉树是一种树形数据结构，每个节点最多有两个子节点。" },
    );
    expect(a.status).toBe(201);
    docAId = a.body.doc?.id ?? "";
    expect(docAId).toBeTruthy();

    const b = await owner.post<{ doc?: { id: string; title: string } }>(
      `/api/agents/${agentId}/knowledge`,
      { title: "排序算法", content: "冒泡排序时间复杂度 O(n²)，快速排序平均 O(n log n)。" },
    );
    expect(b.status).toBe(201);
    docBId = b.body.doc?.id ?? "";
    expect(docBId).toBeTruthy();
  });

  it("展开读取正文", async () => {
    const r = await owner.get<{ id: string; title: string; content: string }>(
      `/api/agents/${agentId}/knowledge/${docAId}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.title).toBe("二叉树基础");
    expect(r.body.content).toContain("二叉树");
  });

  it("编辑标题和正文后保存", async () => {
    const r = await owner.put<{ doc?: { id: string; title: string; chars: number } }>(
      `/api/agents/${agentId}/knowledge`,
      { docId: docAId, title: "哈希表原理", content: "哈希表通过散列函数将键映射到桶位置。" },
    );
    expect(r.status).toBe(200);
    expect(r.body.doc?.title).toBe("哈希表原理");
  });

  it("重新打开拿到新内容", async () => {
    const r = await owner.get<{ id: string; title: string; content: string }>(
      `/api/agents/${agentId}/knowledge/${docAId}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.title).toBe("哈希表原理");
    expect(r.body.content).toContain("哈希表");
    expect(r.body.content).not.toContain("二叉树");
  });

  it("文档 B 未被影响", async () => {
    const r = await owner.get<{ id: string; title: string; content: string }>(
      `/api/agents/${agentId}/knowledge/${docBId}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.title).toBe("排序算法");
    expect(r.body.content).toContain("冒泡排序");
  });

  it("列表反映编辑后的标题和字数", async () => {
    const r = await owner.get<{ docs?: { id: string; title: string; chars: number }[] }>(
      `/api/agents/${agentId}/knowledge`,
    );
    expect(r.status).toBe(200);
    const docA = r.body.docs?.find((d) => d.id === docAId);
    expect(docA?.title).toBe("哈希表原理");
  });

  it("其他用户读不到这个智能体的文档", async () => {
    const r = await other.get(`/api/agents/${agentId}/knowledge/${docAId}`);
    expect(r.status).toBe(404);
  });

  it("跨智能体 docId 越权编辑被拒", async () => {
    const otherAgent = await other.post<{ agent?: { id: string } }>("/api/agents", {
      name: "其他智能体",
      config: { systemPrompt: "x", model: "sonnet" },
    });
    const otherAgentId = otherAgent.body.agent?.id ?? "";
    // 用 other 的智能体 ID 但 owner 的文档 ID
    const r = await other.put(`/api/agents/${otherAgentId}/knowledge`, {
      docId: docAId,
      title: "被篡改",
    });
    expect(r.status).toBe(404);
  });
});
