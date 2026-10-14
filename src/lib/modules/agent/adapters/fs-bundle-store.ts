// 智能体包在会话工作目录里的读写。
//
// 读的时候只认 agent/ 目录,并限制文件数与大小 —— 这些文件是设计师(一个 agent)写的,
// 不能信任它的规模。

import fs from "node:fs/promises";
import path from "node:path";
import { BUNDLE_DIR } from "@/lib/modules/agent/domain/agent-bundle";
import { BUNDLE_README } from "@/lib/modules/agent/domain/architect";

const MAX_FILES = 400;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export async function writeBundle(workspaceDir: string, files: Record<string, string>) {
  const all = { ...files, [`${BUNDLE_DIR}/README.md`]: BUNDLE_README };
  for (const [rel, content] of Object.entries(all)) {
    const target = path.resolve(workspaceDir, rel);
    if (!target.startsWith(path.resolve(workspaceDir) + path.sep)) {
      throw new Error(`bundle path escapes workspace: ${rel}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

/** 读出 agent/ 下的全部文本文件(README.md 除外)。路径相对工作目录,用 / 分隔。 */
export async function readBundle(workspaceDir: string): Promise<Record<string, string>> {
  const root = path.join(workspaceDir, BUNDLE_DIR);
  const out: Record<string, string> = {};
  let total = 0;
  let count = 0;

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      // 不跟随符号链接:否则设计师能把任意文件链进来,经"应用"读出平台上的内容
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = path.relative(workspaceDir, full).split(path.sep).join("/");
      if (rel === `${BUNDLE_DIR}/README.md`) continue;
      if (++count > MAX_FILES) throw new Error(`智能体包文件过多(超过 ${MAX_FILES} 个)`);
      const buf = await fs.readFile(full);
      total += buf.length;
      if (total > MAX_TOTAL_BYTES) throw new Error("智能体包过大(超过 4MB)");
      out[rel] = buf.toString("utf8");
    }
  }
  await walk(root);
  return out;
}
