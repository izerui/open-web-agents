// 上传入库在连接池占满时有界(真实 MySQL 仓储):连接被占住 → 上传进入入库 → 总时长到期 →
// 之后才释放连接。请求必须按时结束、标为没有入库,连接释放后核对确实没有落库,上传名额已归还。
import { randomUUID } from "node:crypto";
import * as schema from "@/lib/db/schema";
import { MysqlKnowledgeRepo } from "@/lib/modules/knowledge/adapters/mysql-knowledge-repo";
import { UPLOAD_LIMITS } from "@/lib/modules/knowledge/application/upload-limits";
import { KNOWLEDGE_LIMITS } from "@/lib/modules/knowledge/domain/limits";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, describe, expect, it, vi } from "vitest";

const URL_ = process.env.OWA_TEST_DATABASE_URL;
const holder: { repo?: MysqlKnowledgeRepo } = {};
vi.mock("@/lib/container", () => ({
  getContainer: () => ({ knowledge: holder.repo, audit: { record: async () => {} } }),
}));
vi.mock("../../_lib/access", () => ({
  requirePermission: async () => ({ agent: { id: "a1", ownerId: "u1" }, principal: {} }),
}));
// 解析不是这里要测的:直接给出结果,让请求很快进入入库
vi.mock("@/lib/modules/knowledge/adapters/extract-text", async (orig) => ({
  ...(await orig<typeof import("@/lib/modules/knowledge/adapters/extract-text")>()),
  extractText: async () => ({ ok: true, format: "text", text: "正文" }),
}));
import { POST } from "../route";

if (!URL_) {
  describe.skip("上传入库连接池有界(未配置 OWA_TEST_DATABASE_URL)", () => {
    it("skipped", () => {});
  });
} else {
  if (!/test/i.test(new URL(URL_).pathname)) throw new Error("Dedicated test database required");
  const pool = mysql.createPool({ uri: URL_, connectionLimit: 1 });
  holder.repo = new MysqlKnowledgeRepo(
    drizzle(pool, { schema, mode: "default" }),
    KNOWLEDGE_LIMITS,
    pool,
  );
  const saved = { ...UPLOAD_LIMITS };
  afterAll(async () => {
    Object.assign(UPLOAD_LIMITS, saved);
    await pool.end();
  });

  describe("上传入库:连接池占满", { timeout: 30_000 }, () => {
    it("到期限就结束请求、标为没有入库;过期后才释放连接,核对没有落库;名额已归还", async () => {
      const agentId = randomUUID().replace(/-/g, "").slice(0, 24);
      await pool.query(
        "INSERT INTO agents (id, owner_id, name, config) VALUES (?, 'u1', '上传测试', '{}')",
        [agentId],
      );
      UPLOAD_LIMITS.budgetMs = 1_500;
      UPLOAD_LIMITS.maxInflight = 1;
      const held = await pool.getConnection();
      const form = new FormData();
      form.append("files", new Blob(["正文"]), "a.txt");
      const start = Date.now();
      const res = await POST(
        new Request(`http://x/api/agents/${agentId}/knowledge/upload`, {
          method: "POST",
          body: form,
        }),
        { params: Promise.resolve({ id: agentId }) },
      );
      const elapsed = Date.now() - start;
      const body = (await res.json()) as { results: { ok: boolean; reason?: string }[] };
      expect(elapsed).toBeLessThan(2_500);
      expect(body.results[0]).toMatchObject({ ok: false });
      expect(body.results[0]?.reason).toContain("没有入库");
      // 期限过后才释放连接:排队中的那次取连接拿到它后立刻归还,不会再去写入
      held.release();
      await new Promise((r) => setTimeout(r, 300));
      const [rows] = await pool.query(
        "SELECT COUNT(*) AS n FROM knowledge_docs WHERE agent_id = ?",
        [agentId],
      );
      expect(Number((rows as { n: number }[])[0]?.n)).toBe(0);
      // 名额归还、连接也回来了:之后的上传照常入库
      UPLOAD_LIMITS.budgetMs = saved.budgetMs;
      const again = new FormData();
      again.append("files", new Blob(["正文"]), "b.txt");
      const ok = await POST(
        new Request(`http://x/api/agents/${agentId}/knowledge/upload`, {
          method: "POST",
          body: again,
        }),
        { params: Promise.resolve({ id: agentId }) },
      );
      expect(ok.status).toBe(201);
    });
  });
}
