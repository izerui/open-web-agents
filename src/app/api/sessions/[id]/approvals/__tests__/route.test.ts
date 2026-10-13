// 审批接口在 Redis 不可用时的有界返回。
//
// 只替换 container,审批端口用的是真实 RedisApproval —— 把它的连接改成"命令永不返回"
// (maxRetriesPerRequest: null 下断网的真实表现),从 HTTP 处理函数这一层断言:
// 请求在有限时间内结束,且是 503 而不是挂住或 500。未配置 OWA_TEST_REDIS_URL 时跳过。

import { RedisApproval } from "@/lib/modules/approval/adapters/redis-approval";
import type Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const URL_ = process.env.OWA_TEST_REDIS_URL;

const holder: { approval?: RedisApproval } = {};
vi.mock("@/lib/container", () => ({
  getContainer: () => ({
    approval: holder.approval,
    auth: {
      resolveWeb: async () => ({ type: "web", userId: "u1" }),
      assertSessionAccess: async () => {},
    },
  }),
}));

if (!URL_) {
  console.warn("[skip] 审批接口有界返回测试未运行 —— 需设置 OWA_TEST_REDIS_URL");
  describe.skip("审批接口(未配置 OWA_TEST_REDIS_URL,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  describe("审批接口:Redis 不可用时有界返回 503", { timeout: 20_000 }, () => {
    let restore = async () => {};

    beforeAll(async () => {
      const approval = new RedisApproval(URL_, { commandTimeoutMs: 300 });
      await approval.listPending("warm-up");
      const cmd = (approval as unknown as { cmd: Redis }).cmd;
      const send = cmd.sendCommand.bind(cmd);
      // 断网:每条命令都进离线队列、永不返回
      cmd.sendCommand = ((c: Parameters<Redis["sendCommand"]>[0]) =>
        c.promise) as Redis["sendCommand"];
      holder.approval = approval;
      restore = async () => {
        cmd.sendCommand = send;
        await approval.close();
      };
    });
    afterAll(async () => {
      await restore();
    });

    const params = { params: Promise.resolve({ id: "s1" }) };

    it("POST 裁决:前置的待审读取就不可用,也在有限时间内返回 503", async () => {
      const { POST } = await import("../route");
      const start = Date.now();
      const res = await POST(
        new Request("http://x/api/sessions/s1/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approvalId: "a1", decision: "approved" }),
        }),
        params,
      );
      expect(Date.now() - start).toBeLessThan(2_000);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/待审列表/);
    });

    it("GET 待审列表:有界返回 503", async () => {
      const { GET } = await import("../route");
      const start = Date.now();
      const res = await GET(new Request("http://x/api/sessions/s1/approvals"), params);
      expect(Date.now() - start).toBeLessThan(2_000);
      expect(res.status).toBe(503);
    });
  });
}
