import { materializeSandbox } from "@/lib/modules/agent-engine/domain/sandbox";
import { describe, expect, it } from "vitest";

const base = {
  enabled: true,
  workspaceDir: "/data/workspaces/s1",
  sharedHome: "/data/.agent-home",
};

describe("materializeSandbox / 启用时", () => {
  it("工作目录与共享 HOME 可写", () => {
    const { sandbox } = materializeSandbox(base);
    const allow = (sandbox?.filesystem as { allowWrite: string[] }).allowWrite;
    expect(allow).toContain("/data/workspaces/s1");
    expect(allow).toContain("/data/.agent-home");
  });

  it("临时目录可写(latex/ffmpeg 等依赖)", () => {
    const allow = (materializeSandbox(base).sandbox?.filesystem as { allowWrite: string[] })
      .allowWrite;
    expect(allow).toContain("/tmp");
    expect(allow).toContain("/dev");
  });

  it("不把宿主 HOME 或根目录放进可写白名单", () => {
    const allow = (materializeSandbox(base).sandbox?.filesystem as { allowWrite: string[] })
      .allowWrite;
    expect(allow).not.toContain("/");
    expect(allow).not.toContain("/Users/liuyuhua");
  });

  it("沙箱起不来就硬失败,绝不裸跑", () => {
    expect(materializeSandbox(base).sandbox?.failIfUnavailable).toBe(true);
  });

  it("禁止模型自行关闭沙箱逃逸", () => {
    expect(materializeSandbox(base).sandbox?.allowUnsandboxedCommands).toBe(false);
  });

  it("默认禁读密钥目录,~ 按 agent 的 HOME 展开", () => {
    const deny = (materializeSandbox(base).sandbox?.filesystem as { denyRead: string[] }).denyRead;
    expect(deny).toContain("/data/.agent-home/.ssh");
    expect(deny).toContain("/data/.agent-home/.aws");
  });

  it("额外可写目录被追加", () => {
    const allow = (
      materializeSandbox({ ...base, extraWriteDirs: ["/opt/models"] }).sandbox?.filesystem as {
        allowWrite: string[];
      }
    ).allowWrite;
    expect(allow).toContain("/opt/models");
  });

  it("可自定义禁读目录", () => {
    const deny = (
      materializeSandbox({ ...base, denyReadDirs: ["/etc/secrets"] }).sandbox?.filesystem as {
        denyRead: string[];
      }
    ).denyRead;
    expect(deny).toEqual(["/etc/secrets"]);
  });
});

describe("materializeSandbox / disallowedTools", () => {
  it("为每个禁读目录生成 Read/Edit/Write 三条 deny", () => {
    const { disallowedTools } = materializeSandbox({ ...base, denyReadDirs: ["/etc/secrets"] });
    expect(disallowedTools).toEqual([
      "Read(/etc/secrets/**)",
      "Edit(/etc/secrets/**)",
      "Write(/etc/secrets/**)",
    ]);
  });

  it("沙箱关闭时仍生成 deny 规则(宿主侧工具不受内核沙箱管)", () => {
    const m = materializeSandbox({ ...base, enabled: false, denyReadDirs: ["~/.ssh"] });
    expect(m.sandbox).toBeUndefined();
    expect(m.disallowedTools).toContain("Write(/data/.agent-home/.ssh/**)");
  });
});
