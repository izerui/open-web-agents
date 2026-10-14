// 把智能体的技能包写成 SDK 能加载的本地插件目录。
//
// 【为什么走插件而不是 settingSources】SDK 默认从 cwd 的 .claude/skills 发现技能,前提是
// settingSources 含 "project" —— 但那样它也会读工作目录里的 .claude/settings.json,
// 而工作目录是 agent 自己能写的:写一份带 hooks 的 settings,命令就可能在沙箱外执行。
// 插件目录由平台写在 dataDir/.skills 下,agent 写不进去(沙箱只放开工作目录,
// 文件写工具也被路径守卫限制在工作目录),也不需要放开 settingSources。
//
// 目录按内容哈希命名:同一份技能包只写一次,内容一变就是新目录 —— 正在跑的运行
// 不会读到写了一半的文件,也不用考虑多个 worker 同时写。

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type SkillPackage, isSafeSkillPath, renderSkillMarkdown } from "@/lib/shared";

const PLUGIN_NAME = "skills";
const DONE_MARKER = ".owa-complete";

function contentHash(pkgs: SkillPackage[]): string {
  const canonical = [...pkgs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      name: p.name,
      description: p.description,
      files: Object.keys(p.files)
        .sort()
        .map((k) => [k, p.files[k]]),
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

/** 返回插件根目录;没有技能包时返回 undefined。 */
export async function materializeSkillPlugin(
  root: string,
  pkgs: SkillPackage[] | undefined,
): Promise<string | undefined> {
  if (!pkgs || pkgs.length === 0) return undefined;
  const dir = path.join(root, contentHash(pkgs));
  if (await exists(path.join(dir, DONE_MARKER))) return dir;

  // 先写到临时目录,写完整再原子改名 —— 别的进程永远看不到写了一半的目录
  const tmp = path.join(root, `.tmp-${randomUUID()}`);
  try {
    await fs.mkdir(path.join(tmp, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: PLUGIN_NAME, version: "1.0.0", description: "智能体自带技能" }),
    );
    for (const pkg of pkgs) {
      const skillDir = path.join(tmp, "skills", pkg.name);
      for (const [rel, content] of Object.entries(pkg.files)) {
        // 保存时校验过,这里再挡一次:路径一旦逃出插件目录就是任意文件写
        if (!isSafeSkillPath(rel)) throw new Error(`unsafe skill file path: ${rel}`);
        const target = path.join(skillDir, rel);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, rel === "SKILL.md" ? renderSkillMarkdown(pkg) : content);
      }
    }
    await fs.writeFile(path.join(tmp, DONE_MARKER), "");
    await fs.rename(tmp, dir).catch(async (err: NodeJS.ErrnoException) => {
      // 另一个进程抢先写好了同一份内容:用它的
      if (err.code === "ENOTEMPTY" || err.code === "EEXIST") return;
      throw err;
    });
    return dir;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}
