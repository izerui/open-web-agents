// invoke 带文件输入、结果附产物清单 —— 真实服务。
// e2e 屏蔽了模型,智能体不会再写新文件:工作目录里就是调用方交来的文件,清单据此断言。

import { beforeAll, describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";

describe("invoke 的文件输入与产物清单", () => {
  let owner: Client;
  let agentId = "";
  let key = "";
  const anon = new Client("anon-files");
  const TEXT = "订单号,金额\nA1,100\n";
  const BIN = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);

  beforeAll(async () => {
    if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
    owner = await newUser("inv-files");
    agentId =
      (
        await owner.post<{ agent?: { id: string } }>("/api/agents", {
          name: `inv-files-${Date.now()}`,
          config: { systemPrompt: "p", model: "sonnet" },
        })
      ).body.agent?.id ?? "";
    key =
      (await owner.post<{ plaintext?: string }>("/api/keys", { name: "f", agentId })).body
        .plaintext ?? "";
  });

  const invoke = (body: unknown, headers: Record<string, string> = {}) =>
    anon.post<{ taskId?: string; sessionId?: string; error?: string }>(
      `/api/agents/${agentId}/invoke`,
      body,
      { "X-Api-Key": key, ...headers },
    );

  it(
    "带文件调用:写进任务工作目录(字节一致);结束后结果附清单,下载路径可用",
    { timeout: 30_000 },
    async () => {
      const r = await invoke({
        input: "对账",
        files: [
          { name: "orders.csv", content: Buffer.from(TEXT).toString("base64") },
          { name: "raw/blob.bin", content: BIN.toString("base64") },
        ],
      });
      expect(r.status).toBe(202);
      const { taskId, sessionId } = r.body;

      let res: {
        done?: boolean;
        files?: { path: string; size: number; download: string }[] | null;
      } = {};
      for (let i = 0; i < 60 && !res.done; i++) {
        res = (await anon.get<typeof res>(`/api/agents/${taskId}/result`, { "X-Api-Key": key }))
          .body;
        if (!res.done) await new Promise((ok) => setTimeout(ok, 300));
      }
      expect(res.done).toBe(true);
      const files = res.files ?? [];
      expect(files.map((f) => f.path).sort()).toEqual(["orders.csv", "raw/blob.bin"]);
      expect(files.find((f) => f.path === "raw/blob.bin")?.size).toBe(BIN.length);

      const csv = files.find((f) => f.path === "orders.csv");
      const dl = await fetch(`${BASE}${csv?.download}`, { headers: { "X-Api-Key": key } });
      expect(dl.status).toBe(200);
      expect(await dl.text()).toBe(TEXT);
      const bin = await fetch(
        `${BASE}/api/sessions/${sessionId}/files?download=${encodeURIComponent("raw/blob.bin")}`,
        { headers: { "X-Api-Key": key } },
      );
      expect(Buffer.from(await bin.arrayBuffer()).equals(BIN)).toBe(true);
    },
  );

  it("不合法的文件:越出目录、隐藏目录、重名、不是 base64、超过个数 —— 400/413,不受理", async () => {
    const b64 = Buffer.from("x").toString("base64");
    for (const files of [
      [{ name: "../escape.txt", content: b64 }],
      [{ name: ".claude/settings.json", content: b64 }],
      [{ name: "/abs.txt", content: b64 }],
      [
        { name: "a.txt", content: b64 },
        { name: "a.txt", content: b64 },
      ],
      [{ name: "a.txt", content: "不是 base64!!" }],
      "not-an-array",
    ]) {
      const r = await invoke({ input: "x", files });
      expect(r.status, JSON.stringify(files)).toBe(400);
    }
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.txt`, content: b64 }));
    expect((await invoke({ input: "x", files: many })).status).toBe(413);
  });

  it("文件内容也算请求内容:同一个幂等键换了文件内容 422,内容相同则重放", async () => {
    const idem = `files-${Date.now()}`;
    const body = (text: string) => ({
      input: "幂等",
      files: [{ name: "a.txt", content: Buffer.from(text).toString("base64") }],
    });
    const first = await invoke(body("一"), { "Idempotency-Key": idem });
    expect(first.status).toBe(202);
    const same = await invoke(body("一"), { "Idempotency-Key": idem });
    expect(same.status).toBe(200);
    expect(same.body.taskId).toBe(first.body.taskId);
    expect((await invoke(body("二"), { "Idempotency-Key": idem })).status).toBe(422);
  });
});
