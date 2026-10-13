// 技能包:智能体自带的 Skill(SKILL.md 加可选的脚本、模板等文件)。
//
// 运行时由引擎写进平台控制的目录,作为本地插件交给 SDK 加载 —— 见
// agent-engine/adapters/claude-sdk/skill-plugin.ts。这里只有形状与校验,零 IO。

export interface SkillPackage {
  /** 技能名:小写字母、数字、连字符。模型据此调用,也是目录名。 */
  name: string;
  /** 一句话说明何时该用这个技能 —— 模型靠它判断要不要自动调用,写清楚很重要。 */
  description: string;
  /**
   * 技能目录里的文件:相对路径 → 文本内容。必须有 SKILL.md(技能的正文说明)。
   * 其它如 scripts/render.py、templates/scene.tsx 由 SKILL.md 引用。
   */
  files: Record<string, string>;
}

export const SKILL_LIMITS = {
  maxSkills: 20,
  maxFilesPerSkill: 50,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
} as const;

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 相对路径:每段只允许常见文件名字符,不允许 ..、绝对路径、隐藏的上跳。 */
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export function isSafeSkillPath(p: string): boolean {
  if (!p || p.length > 512 || p.startsWith("/") || p.includes("\\")) return false;
  return p.split("/").every((seg) => SAFE_SEGMENT.test(seg) && seg !== "..");
}

/** 返回问题列表(字段路径 + 说明);空数组 = 合法。 */
export function validateSkillPackages(pkgs: unknown): { field: string; message: string }[] {
  if (pkgs === undefined) return [];
  if (!Array.isArray(pkgs)) return [{ field: "skillPackages", message: "必须是数组" }];
  const issues: { field: string; message: string }[] = [];
  if (pkgs.length > SKILL_LIMITS.maxSkills) {
    issues.push({ field: "skillPackages", message: `最多 ${SKILL_LIMITS.maxSkills} 个技能` });
  }
  const seen = new Set<string>();
  let total = 0;
  for (const [i, raw] of pkgs.entries()) {
    const at = `skillPackages[${i}]`;
    const p = raw as Partial<SkillPackage>;
    if (typeof p?.name !== "string" || !SKILL_NAME.test(p.name)) {
      issues.push({ field: `${at}.name`, message: "技能名只能用小写字母、数字、连字符,最长 64" });
    } else if (seen.has(p.name)) {
      issues.push({ field: `${at}.name`, message: `技能重复:${p.name}` });
    } else {
      seen.add(p.name);
    }
    if (
      typeof p?.description !== "string" ||
      !p.description.trim() ||
      p.description.length > 1024
    ) {
      issues.push({
        field: `${at}.description`,
        message: "描述必填(1~1024 字)—— 模型靠它判断何时调用这个技能",
      });
    }
    const files = p?.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      issues.push({ field: `${at}.files`, message: "files 必须是 { 路径: 内容 } 对象" });
      continue;
    }
    const entries = Object.entries(files);
    if (!("SKILL.md" in files)) {
      issues.push({ field: `${at}.files`, message: "缺少 SKILL.md" });
    }
    if (entries.length > SKILL_LIMITS.maxFilesPerSkill) {
      issues.push({
        field: `${at}.files`,
        message: `单个技能最多 ${SKILL_LIMITS.maxFilesPerSkill} 个文件`,
      });
    }
    for (const [path, content] of entries) {
      if (!isSafeSkillPath(path)) {
        issues.push({ field: `${at}.files`, message: `不允许的文件路径:${path}` });
        continue;
      }
      if (typeof content !== "string") {
        issues.push({ field: `${at}.files`, message: `${path} 的内容必须是文本` });
        continue;
      }
      const bytes = new TextEncoder().encode(content).length;
      total += bytes;
      if (bytes > SKILL_LIMITS.maxFileBytes) {
        issues.push({ field: `${at}.files`, message: `${path} 超过 256KB` });
      }
    }
  }
  if (total > SKILL_LIMITS.maxTotalBytes) {
    issues.push({ field: "skillPackages", message: "全部技能文件合计超过 2MB" });
  }
  return issues;
}

/**
 * 生成交给 SDK 的 SKILL.md:SDK 靠 frontmatter 里的 name / description 发现与调用技能。
 * 作者写的 SKILL.md 若已自带 frontmatter,以平台字段为准替换掉,避免两处说法不一致。
 */
export function renderSkillMarkdown(pkg: SkillPackage): string {
  const body = (pkg.files["SKILL.md"] ?? "").replace(/^---\n[\s\S]*?\n---\n?/, "");
  const desc = pkg.description.replace(/\r?\n/g, " ").trim();
  return `---\nname: ${pkg.name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body.trimStart()}`;
}
