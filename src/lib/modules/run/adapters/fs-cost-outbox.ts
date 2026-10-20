// 费用恢复记录落在本机数据目录:一次运行一个文件。写库失败、写库途中进程被杀时,
// 同一台机器上的 worker 重启后补写。不放数据库 —— 正是数据库写不进去时才需要它。
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CostOutbox } from "../ports";

/** 运行 id 只允许这些字符,防止拼出目录之外的路径 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SUFFIX = ".json";

export class FsCostOutbox implements CostOutbox {
  constructor(
    private readonly dir: string,
    private readonly onError: (message: string, err: unknown) => void = (m, e) =>
      console.warn(`[owa][cost-outbox] ${m}:`, e instanceof Error ? e.message : e),
  ) {}

  private file(runId: string): string {
    if (!SAFE_ID.test(runId)) throw new Error(`运行 id 不合法: ${runId}`);
    return path.join(this.dir, `${runId}${SUFFIX}`);
  }

  async save(runId: string, cost: unknown): Promise<void> {
    const target = this.file(runId);
    await fs.mkdir(this.dir, { recursive: true });
    // 先写临时文件并落盘,再改名:改名是原子的,读到的要么是旧的、要么是完整的新文件
    const tmp = path.join(this.dir, `.${runId}.${randomUUID()}.tmp`);
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify({ runId, cost }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    // 目录项也落盘,断电后改名不丢(不支持的平台忽略)
    const dirHandle = await fs.open(this.dir, "r").catch(() => null);
    await dirHandle?.sync().catch(() => {});
    await dirHandle?.close();
  }

  async remove(runId: string): Promise<void> {
    await fs.rm(this.file(runId), { force: true });
  }

  async list(): Promise<{ runId: string; cost: unknown }[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: { runId: string; cost: unknown }[] = [];
    for (const name of names) {
      // 临时文件(以 . 开头)是没写完的,忽略
      if (name.startsWith(".") || !name.endsWith(SUFFIX)) continue;
      const runId = name.slice(0, -SUFFIX.length);
      if (!SAFE_ID.test(runId)) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.dir, name), "utf8")) as {
          runId?: unknown;
          cost?: unknown;
        };
        if (parsed.runId !== runId || parsed.cost == null) throw new Error("内容不完整");
        out.push({ runId, cost: parsed.cost });
      } catch (err) {
        // 不删:留给人看;也不让一个坏文件挡住其他的补写
        this.onError(`恢复记录无法读取(${name}),跳过`, err);
      }
    }
    return out;
  }
}

/** 测试用:可在两个 worker 实例之间共享,模拟同一台机器重启 */
export class InMemoryCostOutbox implements CostOutbox {
  readonly files = new Map<string, unknown>();
  async save(runId: string, cost: unknown) {
    this.files.set(runId, structuredClone(cost));
  }
  async remove(runId: string) {
    this.files.delete(runId);
  }
  async list() {
    return [...this.files].map(([runId, cost]) => ({ runId, cost: structuredClone(cost) }));
  }
}
