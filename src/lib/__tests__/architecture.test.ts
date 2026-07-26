// 架构边界的机械检查。
//
// 【为什么要有这个文件】架构文稿 §9 的缓解措施里写着"ESLint 依赖边界规则
// (禁跨模块 import 内部)",但项目用的是 Biome,而 Biome 的 noRestrictedImports
// 只认精确模块名,表达不了 "@/lib/modules/*/adapters/**" 这种形态。
// 于是那条缓解措施一直停留在纸面上 —— 边界全靠目录约定和自觉。
//
// 而这些规则本来就是【可以机械判定】的。靠自觉维持的约束,在第一个赶工的下午就会破。
// 更重要的是:README 和代码注释里对外做了几条硬声明(只有一个文件 import SDK、
// domain 零框架依赖),声明如果没有检查兜着,迟早会变成假话 ——
// 这一轮审查已经抓到过好几条"文档说了、实际没有"。
//
// 这些检查读源码文本判断,不需要跑起来,所以很快、也不依赖外部服务。

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");
const MODULES = path.join(SRC, "lib/modules");

/** 递归列出源码文件(跳过测试与契约夹具)。 */
function sourceFiles(dir: string, skipTests = true): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skipTests && e.name === "__tests__") continue;
      out.push(...sourceFiles(p, skipTests));
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 只取 import/from 语句里的模块说明符,避免把注释里的提及算进来。 */
function importsOf(code: string): string[] {
  return [...code.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+"([^"]+)"/g)].map(
    (m) => m[1] as string,
  );
}

const rel = (p: string) => path.relative(SRC, p);

describe("架构边界 / 依赖铁律", () => {
  // 域层零框架依赖是"可以 100% 单测"的前提。一旦 domain 里出现 drizzle 或 next,
  // 纯逻辑测试就得先起数据库或造请求上下文,那条最便宜的反馈回路就没了。
  const FORBIDDEN = ["next", "next/", "drizzle-orm", "ioredis", "mysql2", "@anthropic-ai/"];

  const domainFiles = [
    ...sourceFiles(path.join(SRC, "lib/shared")),
    ...readdirSync(MODULES)
      .map((m) => path.join(MODULES, m, "domain"))
      .filter((d) => {
        try {
          readdirSync(d);
          return true;
        } catch {
          return false;
        }
      })
      .flatMap((d) => sourceFiles(d)),
  ];

  it("扫到的 domain/shared 文件数量合理(防止检查本身空转)", () => {
    // 没有这条,上面的目录拼错时检查会"零违规通过"——一个永远绿的测试
    expect(domainFiles.length).toBeGreaterThan(15);
  });

  for (const f of domainFiles) {
    it(`${rel(f)} 不依赖框架`, () => {
      const bad = importsOf(readFileSync(f, "utf8")).filter((s) =>
        FORBIDDEN.some((x) => s === x || s.startsWith(x)),
      );
      expect(bad).toEqual([]);
    });
  }
});

describe("架构边界 / 模块间只经公开面交互", () => {
  const files = sourceFiles(MODULES);

  it("扫到的模块文件数量合理", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  // 允许被别的模块 import 的目录:端口、用例、域逻辑。
  // adapters 是实现细节 —— 跨模块直接 import 它,等于把"可替换"这件事作废:
  // 换实现时要改的就不只是 container 一处了。
  // 注意不带 .ts —— import 说明符里没有扩展名,`assistant/ports` 切出来是 `ports`
  const PUBLIC = new Set(["ports", "ports.contract", "application", "domain"]);

  it("没有任何模块直接 import 别的模块的 adapters/", () => {
    const violations: string[] = [];
    for (const f of files) {
      const self = path.relative(MODULES, f).split(path.sep)[0];
      for (const spec of importsOf(readFileSync(f, "utf8"))) {
        const m = spec.match(/^@\/lib\/modules\/([^/]+)\/(.+)$/);
        if (!m) continue;
        const [, mod, rest] = m;
        if (mod === self) continue;
        const head = (rest as string).split("/")[0] as string;
        if (!PUBLIC.has(head)) violations.push(`${self} → ${mod}/${rest}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("架构边界 / SDK 只在一个文件里", () => {
  // README 明确对外声称"全工程只有一个文件 import SDK",这是 ACL 能成立的前提:
  // SDK 升级只改归一层。声称一旦失真,读者对整份文档的信任都会打折。
  it("import @anthropic-ai/claude-agent-sdk 的文件恰好是 default-engine.ts", () => {
    const all = [...sourceFiles(path.join(SRC, "lib")), ...sourceFiles(path.join(SRC, "app"))];
    const importers = all.filter((f) =>
      importsOf(readFileSync(f, "utf8")).some((s) =>
        s.startsWith("@anthropic-ai/claude-agent-sdk"),
      ),
    );
    expect(importers.map(rel)).toEqual([
      "lib/modules/agent-engine/adapters/claude-sdk/default-engine.ts",
    ]);
  });
});

describe("架构边界 / 容器是唯一的装配点", () => {
  // 端口的意义在于"换实现只改 container"。如果路由层直接 new 一个具体 adapter,
  // 这句话就不成立了 —— 而且这种绕过很难在 review 里被看见。
  it("app/ 下的路由不直接 new 具体 adapter", () => {
    const files = sourceFiles(path.join(SRC, "app"));
    const bad: string[] = [];
    for (const f of files) {
      const code = readFileSync(f, "utf8");
      // 具体实现的命名约定:Mysql* / Redis* / LocalFs* / InMemory*
      const m = code.match(/new\s+(Mysql|Redis|LocalFs|InMemory)[A-Za-z]*\s*\(/);
      if (m) bad.push(`${rel(f)}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});
