import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    /**
     * 测试文件【串行】跑。
     *
     * 契约测试与并发压力测试都打同一个测试库,而队列的语义本身就是全局的 ——
     * claimNext 取的是全表最旧的一条,_truncate 清的是整张表。文件级并行下,
     * A 文件的 truncate 会把 B 文件刚入队的任务删掉,B 于是断言失败。
     *
     * 这正是之前那两次"复现不了的偶发失败"的来源:并行度够低时撞不上,
     * 加到第三个 DB 测试文件就变成必现。当时没找到根因,只把时间预算调宽了 ——
     * 那是在掩盖症状。
     *
     * 全套跑完约 3 秒,串行换来的确定性远比这点墙钟时间值钱:
     * 一个偶发失败的测试套件,等于没有测试套件。
     */
    fileParallelism: false,
  },
});
