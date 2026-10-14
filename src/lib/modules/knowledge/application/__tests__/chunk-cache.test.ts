import { ChunkCache } from "@/lib/modules/knowledge/application/chunk-cache";
import type { Chunk } from "@/lib/modules/knowledge/domain/retrieval";
import { describe, expect, it } from "vitest";

function source() {
  const s = {
    sig: "v1",
    loads: 0,
    async signatureOf() {
      return s.sig;
    },
    async chunksOf(): Promise<Chunk[]> {
      s.loads++;
      return [{ docId: "d", docTitle: "t", index: 0, text: s.sig }];
    },
  };
  return s;
}

describe("ChunkCache", () => {
  it("文档集合没变就不重读正文", async () => {
    const src = source();
    const cache = new ChunkCache(src);
    await cache.chunksOf("a1");
    await cache.chunksOf("a1");
    expect(src.loads).toBe(1);
  });

  it("指纹变了立刻重读 —— 别的进程增删文档,下一轮就能看到", async () => {
    const src = source();
    const cache = new ChunkCache(src);
    await cache.chunksOf("a1");
    src.sig = "v2";
    expect((await cache.chunksOf("a1"))[0]?.text).toBe("v2");
    expect(src.loads).toBe(2);
  });

  it("超过容量淘汰最久未用的", async () => {
    const src = source();
    const cache = new ChunkCache(src, 2);
    await cache.chunksOf("a");
    await cache.chunksOf("b");
    await cache.chunksOf("a"); // a 变成最近使用
    await cache.chunksOf("c"); // 淘汰 b
    src.loads = 0;
    await cache.chunksOf("a");
    await cache.chunksOf("b");
    expect(src.loads).toBe(1);
  });
});
