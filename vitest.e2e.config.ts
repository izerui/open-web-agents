import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 端到端测试:对【真正跑着的服务】从 HTTP 打进去。
 *
 * 为什么要和单测分开跑:
 * - 它需要外部前置条件(服务 + MySQL + Redis),不该拖慢日常的 `pnpm test`
 * - 它按顺序改真实数据(注册用户、建助手、发 key),必须串行
 *
 * 起停由 scripts/e2e.sh 负责;也可以自己起好服务后直接 `pnpm test:e2e:run`。
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.ts"],
    fileParallelism: false,
    // 端到端断言要等真实 IO,给足预算但别无限等
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
