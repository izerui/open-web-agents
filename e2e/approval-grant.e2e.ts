// 审批分级 —— 真实服务 + Redis:以 worker 身份发起待审,经 HTTP 批准并授权本会话内同类,
// 列表里看得到、能撤销、进审计;别人碰不到。

import { describe, expect, it } from "vitest";
import { Client, newUser, serverUp } from "./client";

type Audit = { items?: { action: string; details?: Record<string, unknown> }[] };

describe("审批分级(真实服务 + Redis)", () => {
  const redisUrl = process.env.OWA_E2E_REDIS_URL;
  if (!redisUrl) {
    console.warn("[skip] 审批分级用例未运行 —— 需由 scripts/e2e.sh 起服务并设置 OWA_REDIS_URL");
  }

  it.skipIf(!redisUrl)(
    "批准并授权同类 → 列表里有 → 撤销 → 没了;拒绝不能授权;别人碰不到",
    async () => {
      if (!(await serverUp())) throw new Error("e2e 需要一个跑着的服务");
      const { RedisApproval } = await import("@/lib/modules/approval/adapters/redis-approval");
      const owner = await newUser("grant");
      const stranger = await newUser("grant-x");
      const sessionId =
        (await owner.post<{ session?: { id: string } }>("/api/sessions", { agentId: "default" }))
          .body.session?.id ?? "";
      expect(sessionId).toBeTruthy();

      const approval = new RedisApproval(redisUrl as string);
      const scopes = [{ key: "bash:curl", label: "含「curl」的命令" }];
      const ask = (id: string) =>
        approval.request({
          id,
          sessionId,
          runId: "run-e2e",
          toolName: "Bash",
          summary: "curl https://example.com",
          reason: "命令包含高风险模式:curl",
          scopes,
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        });
      const waitPending = async (id: string) => {
        for (let i = 0; i < 50; i++) {
          const p = await owner.get<{ pending?: { id: string }[] }>(
            `/api/sessions/${sessionId}/approvals`,
          );
          if ((p.body.pending ?? []).some((x) => x.id === id)) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error("待审没出现");
      };

      try {
        // 拒绝时不能授权同类
        const a0 = `ap0-${Date.now()}`;
        const o0 = ask(a0);
        await waitPending(a0);
        const bad = await owner.post(`/api/sessions/${sessionId}/approvals`, {
          approvalId: a0,
          decision: "denied",
          remember: "session",
        });
        expect(bad.status).toBe(400);
        // 拒绝并说明:说明交到等待方
        await owner.post(`/api/sessions/${sessionId}/approvals`, {
          approvalId: a0,
          decision: "denied",
          message: "改用内部镜像",
        });
        expect(await o0).toMatchObject({ decision: "denied", message: "改用内部镜像" });

        // 批准并授权同类
        const a1 = `ap1-${Date.now()}`;
        const o1 = ask(a1);
        await waitPending(a1);
        const ok = await owner.post<{ remembered?: boolean }>(
          `/api/sessions/${sessionId}/approvals`,
          {
            approvalId: a1,
            decision: "approved",
            remember: "session",
          },
        );
        expect(ok.status).toBe(200);
        expect(ok.body.remembered).toBe(true);
        expect((await o1).decision).toBe("approved");

        const listed = await owner.get<{ grants?: { key: string; label: string }[] }>(
          `/api/sessions/${sessionId}/approvals`,
        );
        expect(listed.body.grants?.map((g) => g.key)).toEqual(["bash:curl"]);

        // 别人看不到、撤不了
        expect([403, 404]).toContain(
          (await stranger.get(`/api/sessions/${sessionId}/approvals`)).status,
        );
        expect([403, 404]).toContain(
          (await stranger.del(`/api/sessions/${sessionId}/approvals?grant=bash%3Acurl`)).status,
        );

        // 撤销
        expect(
          (await owner.del(`/api/sessions/${sessionId}/approvals?grant=bash%3Acurl`)).status,
        ).toBe(200);
        const after = await owner.get<{ grants?: unknown[] }>(
          `/api/sessions/${sessionId}/approvals`,
        );
        expect(after.body.grants).toEqual([]);

        const audit = await owner.get<Audit>("/api/audit?limit=200");
        const actions = (audit.body.items ?? []).map((e) => e.action);
        expect(actions).toContain("approval.revoke_grant");
        const decided = (audit.body.items ?? []).find(
          (e) => e.action === "approval.decide" && e.details?.approvalId === a1,
        );
        expect(decided?.details).toMatchObject({ remember: true, grantCategories: ["bash:curl"] });
      } finally {
        await approval.close();
      }
    },
  );
});
