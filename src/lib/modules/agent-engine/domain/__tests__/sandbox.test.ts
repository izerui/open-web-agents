import { materializeSandbox } from "@/lib/modules/agent-engine/domain/sandbox";
import { describe, expect, it } from "vitest";

const base = {
  enabled: true,
  workspaceDir: "/data/workspaces/s1",
  sharedHome: "/data/.agent-home",
  hostHome: "/Users/operator",
  platform: "linux" as NodeJS.Platform,
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

  // 【回归】`~` 曾经按 agent 的 sharedHome 展开,两头都错:
  // ~/.claude 展成 .agent-home/.claude —— 那是 SDK 自己存 session 与 shell snapshot
  // 的地方,Bash wrapper 必须能读;而宿主真实的 ~/.claude(平台运维的凭证)反倒没拦住。
  it("默认禁读密钥目录,~ 按【宿主真实 HOME】展开", () => {
    const deny = (materializeSandbox(base).sandbox?.filesystem as { denyRead: string[] }).denyRead;
    expect(deny).toContain("/Users/operator/.ssh");
    expect(deny).toContain("/Users/operator/.aws");
    expect(deny).toContain("/Users/operator/.claude");
  });

  it("不误伤 agent 自己的 HOME —— SDK 的 session 与 shell snapshot 要能读", () => {
    const deny = (materializeSandbox(base).sandbox?.filesystem as { denyRead: string[] }).denyRead;
    expect(deny.some((d) => d.startsWith("/data/.agent-home"))).toBe(false);
  });

  it("临时目录按平台取 —— /private/* 是 macOS 特有", () => {
    const linux = (materializeSandbox(base).sandbox?.filesystem as { allowWrite: string[] })
      .allowWrite;
    expect(linux).not.toContain("/private/tmp");

    const mac = (
      materializeSandbox({ ...base, platform: "darwin" }).sandbox?.filesystem as {
        allowWrite: string[];
      }
    ).allowWrite;
    expect(mac).toContain("/private/tmp");
    expect(mac).toContain("/private/var/folders");
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
    expect(m.disallowedTools).toContain("Write(/Users/operator/.ssh/**)");
  });
});

/**
 * 生产部署(Linux 容器)的关键约束。
 *
 * 【为什么单独一组】上面那些用的是简化路径,而生产是 /app/data/** 这套。
 * 沙箱配置错了不会报错 —— 只会静默地多给或少给权限,所以这几条把
 * “容器里到底放开了什么”钉死。
 */
describe("materializeSandbox / 生产容器(Linux)", () => {
  const prod = {
    enabled: true,
    workspaceDir: "/app/data/workspaces/abc123",
    sharedHome: "/app/data/.agent-home",
    hostHome: "/home/owa",
    platform: "linux" as NodeJS.Platform,
  };
  const allowOf = () =>
    (materializeSandbox(prod).sandbox?.filesystem as { allowWrite: string[] }).allowWrite;

  it("只放开本会话工作目录与 agent HOME", () => {
    const allow = allowOf();
    expect(allow).toContain("/app/data/workspaces/abc123");
    expect(allow).toContain("/app/data/.agent-home");
    // 不能把整个数据目录或其他会话放进来
    expect(allow).not.toContain("/app/data");
    expect(allow).not.toContain("/app/data/workspaces");
  });

  it("不放开应用代码目录 —— agent 不该能改自己跑的程序", () => {
    const allow = allowOf();
    expect(allow).not.toContain("/app");
    expect(allow.some((p) => p === "/app" || p === "/app/src")).toBe(false);
  });

  it("不含 macOS 特有路径", () => {
    expect(allowOf().some((p) => p.startsWith("/private"))).toBe(false);
  });

  it("宿主凭证目录被禁读(容器里运行用户是 owa)", () => {
    const deny = (materializeSandbox(prod).sandbox?.filesystem as { denyRead: string[] }).denyRead;
    expect(deny).toContain("/home/owa/.ssh");
    expect(deny).toContain("/home/owa/.claude");
  });

  // 这两条是“起不来就硬失败”的基础:容器环境若禁了 userns,bubblewrap 起不来,
  // 此时宁可整批任务失败,也不能静默降级成无沙箱裸跑。
  it("沙箱起不来即硬失败,没有降级裸跑这一档", () => {
    expect(materializeSandbox(prod).sandbox?.failIfUnavailable).toBe(true);
  });

  it("模型不能用 dangerouslyDisableSandbox 逃逸", () => {
    expect(materializeSandbox(prod).sandbox?.allowUnsandboxedCommands).toBe(false);
  });
});
