import {
  type GuardPolicy,
  guardToolUse,
  isGuardedTool,
} from "@/lib/modules/agent-engine/domain/tool-guard";
import { describe, expect, it } from "vitest";

const policy: GuardPolicy = {
  workspaceDir: "/data/workspaces/s1",
  allowedDirs: ["/data/.agent-home", "/tmp"],
};

describe("guardToolUse / 写入类工具", () => {
  it("工作空间内的绝对路径放行", () => {
    expect(guardToolUse("Write", { file_path: "/data/workspaces/s1/out.txt" }, policy).allow).toBe(
      true,
    );
  });

  it("工作空间子目录放行", () => {
    expect(
      guardToolUse("Write", { file_path: "/data/workspaces/s1/sub/deep/a.md" }, policy).allow,
    ).toBe(true);
  });

  it("【真实事故】写到宿主 HOME 被拒", () => {
    const d = guardToolUse("Write", { file_path: "/Users/liuyuhua/hello.txt" }, policy);
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toMatch(/工作空间之外/);
  });

  it("写到别人的会话目录被拒", () => {
    expect(
      guardToolUse("Write", { file_path: "/data/workspaces/s2/steal.txt" }, policy).allow,
    ).toBe(false);
  });

  it("挡住伪前缀的兄弟目录(字符串前缀比较会漏)", () => {
    expect(
      guardToolUse("Write", { file_path: "/data/workspaces/s1-evil/x.txt" }, policy).allow,
    ).toBe(false);
  });

  it("挡住 .. 穿越", () => {
    expect(guardToolUse("Write", { file_path: "/data/workspaces/s1/../s2/x" }, policy).allow).toBe(
      false,
    );
  });

  it("内部先上后下但仍在工作空间内则放行", () => {
    expect(
      guardToolUse("Write", { file_path: "/data/workspaces/s1/sub/../ok.txt" }, policy).allow,
    ).toBe(true);
  });

  it("Edit 与 NotebookEdit 同样受管", () => {
    expect(guardToolUse("Edit", { file_path: "/etc/passwd" }, policy).allow).toBe(false);
    expect(guardToolUse("NotebookEdit", { notebook_path: "/etc/x.ipynb" }, policy).allow).toBe(
      false,
    );
  });

  it("额外允许目录(共享 HOME / 临时目录)可写 —— 工具缓存需要", () => {
    expect(guardToolUse("Write", { file_path: "/data/.agent-home/.cache/x" }, policy).allow).toBe(
      true,
    );
    expect(guardToolUse("Write", { file_path: "/tmp/scratch" }, policy).allow).toBe(true);
  });

  it("缺少路径参数时不阻断(交给 SDK 自己报参数错误)", () => {
    expect(guardToolUse("Write", {}, policy).allow).toBe(true);
    expect(guardToolUse("Write", { file_path: "" }, policy).allow).toBe(true);
    expect(guardToolUse("Write", { file_path: 123 }, policy).allow).toBe(true);
  });
});

describe("guardToolUse / 读取类工具", () => {
  it("默认不限制读 —— agent 常需读系统文件与文档", () => {
    expect(guardToolUse("Read", { file_path: "/etc/hosts" }, policy).allow).toBe(true);
  });

  it("开启 restrictReads 后越界读被拒", () => {
    const strict = { ...policy, restrictReads: true };
    expect(guardToolUse("Read", { file_path: "/etc/hosts" }, strict).allow).toBe(false);
    expect(guardToolUse("Read", { file_path: "/data/workspaces/s1/a.txt" }, strict).allow).toBe(
      true,
    );
  });
});

describe("guardToolUse / 不假装能管 Bash", () => {
  it("Bash 一律放行 —— 命令文本里的路径匹配不可信,只能靠内核/容器沙箱", () => {
    expect(
      guardToolUse("Bash", { command: "echo x > /Users/liuyuhua/escape.txt" }, policy).allow,
    ).toBe(true);
  });
});

describe("guardToolUse / 未知工具", () => {
  it("未识别的工具放行,避免 SDK 新增工具时静默弄坏助手", () => {
    expect(guardToolUse("WebFetch", { url: "https://x.com" }, policy).allow).toBe(true);
    expect(guardToolUse("SomeFutureTool", { anything: 1 }, policy).allow).toBe(true);
  });
});

describe("isGuardedTool", () => {
  it("覆盖宿主侧文件工具", () => {
    expect(isGuardedTool("Write")).toBe(true);
    expect(isGuardedTool("Edit")).toBe(true);
    expect(isGuardedTool("Read")).toBe(true);
  });
  it("不覆盖 Bash 与其它", () => {
    expect(isGuardedTool("Bash")).toBe(false);
    expect(isGuardedTool("WebSearch")).toBe(false);
  });
});
