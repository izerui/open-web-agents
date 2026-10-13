// 知识片段缓存:按文档集合指纹缓存切好的片段。
//
// 【为什么需要】检索曾经每次运行都把该智能体的全部文档正文读出来、现场切块 ——
// 复杂度随语料线性增长,文档一多,每轮运行都白白多读几 MB。
// 现在先查一次只碰 id 与时间列的指纹,没变就复用上次切好的片段。
// 指纹每次都查,所以别的进程增删了文档,这里下一轮就能看到,不存在过期窗口。

import type { Chunk } from "@/lib/modules/knowledge/domain/retrieval";

export interface ChunkSource {
  signatureOf(agentId: string): Promise<string>;
  chunksOf(agentId: string): Promise<Chunk[]>;
}

export class ChunkCache {
  private readonly entries = new Map<string, { sig: string; chunks: Chunk[] }>();

  constructor(
    private readonly source: ChunkSource,
    private readonly maxAgents = 200,
  ) {}

  async chunksOf(agentId: string): Promise<Chunk[]> {
    const sig = await this.source.signatureOf(agentId);
    const hit = this.entries.get(agentId);
    if (hit && hit.sig === sig) {
      // 重新插入,让 Map 的插入序充当最近使用序
      this.entries.delete(agentId);
      this.entries.set(agentId, hit);
      return hit.chunks;
    }
    const chunks = await this.source.chunksOf(agentId);
    this.entries.delete(agentId);
    this.entries.set(agentId, { sig, chunks });
    while (this.entries.size > this.maxAgents) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return chunks;
  }
}
