import {
  isSafeSdkSessionId,
  projectDirNameFor,
  transcriptPathFor,
} from "@/lib/modules/agent-engine/domain/transcript-path";
import { describe, expect, it } from "vitest";

describe("projectDirNameFor", () => {
  // 这条编码规则是对着真实盘上的目录反推出来的:
  //   cwd = /Users/x/proj/data/workspaces/abc
  //   目录 = -Users-x-proj-data-workspaces-abc
  // 推错一个字符就整个读不到 —— 所以拿真实样本钉死。
  it("把工作目录绝对路径的分隔符换成短横线", () => {
    expect(
      projectDirNameFor("/Users/liuyuhua/github/open-web-agents/data/workspaces/4f7a1f75"),
    ).toBe("-Users-liuyuhua-github-open-web-agents-data-workspaces-4f7a1f75");
  });

  it("保留开头的分隔符(变成前导短横线)", () => {
    expect(projectDirNameFor("/a/b")).toBe("-a-b");
  });

  // 同样是从真实盘上反推的 —— 本机 ~/.claude/projects 下就有这个目录:
  //   cwd = /Users/liuyuhua/github/open-web-agents/.claude/worktrees/streaming-fix
  //   目录 = -Users-liuyuhua-github-open-web-agents--claude-worktrees-streaming-fix
  // 注意 `.claude` 那一段变成了 `--claude`:分隔符和点【各贡献一个】短横线。
  // 只替换分隔符的话会推成 `-.claude`,读不到文件,而表现是空白页面不是报错。
  it("点也要换成短横线 —— 否则含点的路径整个读不到", () => {
    expect(
      projectDirNameFor("/Users/liuyuhua/github/open-web-agents/.claude/worktrees/streaming-fix"),
    ).toBe("-Users-liuyuhua-github-open-web-agents--claude-worktrees-streaming-fix");
  });

  // 触发场景不需要改代码,改部署配置就够:OWA_DATA_DIR=/srv/app.v2/data
  it("dataDir 含点时同样成立(部署配置就能触发)", () => {
    expect(projectDirNameFor("/srv/app.v2/data/workspaces/s1")).toBe(
      "-srv-app-v2-data-workspaces-s1",
    );
  });

  it("要求绝对路径 —— 相对路径推出来的目录名必然对不上盘上的", () => {
    expect(() => projectDirNameFor("data/workspaces/abc")).toThrow(/absolute/i);
  });
});

describe("isSafeSdkSessionId", () => {
  it("接受 SDK 的 UUID 形态", () => {
    expect(isSafeSdkSessionId("1f4c20d8-ce64-42cf-a12b-d5a866be1f81")).toBe(true);
  });

  it("拒绝路径穿越与分隔符 —— 它要当文件名用", () => {
    expect(isSafeSdkSessionId("..")).toBe(false);
    expect(isSafeSdkSessionId("../../etc/passwd")).toBe(false);
    expect(isSafeSdkSessionId("a/b")).toBe(false);
    expect(isSafeSdkSessionId("a\\b")).toBe(false);
  });

  it("拒绝空与超长", () => {
    expect(isSafeSdkSessionId("")).toBe(false);
    expect(isSafeSdkSessionId("x".repeat(129))).toBe(false);
  });
});

describe("transcriptPathFor", () => {
  it("拼出 dataDir/.agent-home/.claude/projects/<编码目录>/<sdkSessionId>.jsonl", () => {
    expect(
      transcriptPathFor({
        dataDir: "/srv/owa/data",
        workspaceDir: "/srv/owa/data/workspaces/sess1",
        sdkSessionId: "1f4c20d8-ce64-42cf-a12b-d5a866be1f81",
      }),
    ).toBe(
      "/srv/owa/data/.agent-home/.claude/projects/-srv-owa-data-workspaces-sess1/1f4c20d8-ce64-42cf-a12b-d5a866be1f81.jsonl",
    );
  });

  it("挡住经 sdkSessionId 的路径穿越", () => {
    expect(() =>
      transcriptPathFor({
        dataDir: "/srv/owa/data",
        workspaceDir: "/srv/owa/data/workspaces/sess1",
        sdkSessionId: "../../../../etc/passwd",
      }),
    ).toThrow(/unsafe/i);
  });
});
