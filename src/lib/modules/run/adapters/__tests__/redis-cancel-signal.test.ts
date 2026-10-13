// 取消通知对真实 Redis 的测试。未配置 OWA_TEST_REDIS_URL 时跳过并说明。

import { RedisCancelSignal } from "@/lib/modules/run/adapters/redis-cancel-signal";
import { describe, expect, it } from "vitest";

const URL_ = process.env.OWA_TEST_REDIS_URL;

if (!URL_) {
  console.warn("[skip] RedisCancelSignal 测试未运行 —— 需设置 OWA_TEST_REDIS_URL");
  describe.skip("RedisCancelSignal(未配置 OWA_TEST_REDIS_URL,已跳过)", () => {
    it("skipped", () => {});
  });
} else {
  describe("RedisCancelSignal", () => {
    it("一个进程发出的取消,另一个进程的订阅者收得到", async () => {
      const web = new RedisCancelSignal(URL_);
      const worker = new RedisCancelSignal(URL_);
      const got: string[] = [];
      worker.subscribe((id) => got.push(id));
      // 等订阅建立
      await new Promise((r) => setTimeout(r, 300));
      await web.publish("run-42");
      for (let i = 0; i < 100 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(got).toEqual(["run-42"]);
      await Promise.all([web.close(), worker.close()]);
    });

    it("Redis 不可用时发布不会卡住取消接口", async () => {
      const dead = new RedisCancelSignal("redis://127.0.0.1:6399");
      const start = Date.now();
      await dead.publish("x");
      expect(Date.now() - start).toBeLessThan(3_000);
      await dead.close();
    });
  });
}
