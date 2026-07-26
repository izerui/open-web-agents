import {
  DEFAULT_GC_POLICY,
  type WorkspaceInfo,
  decideGc,
  isIntermediate,
} from "@/lib/modules/artifacts/domain/gc-policy";
import { describe, expect, it } from "vitest";

const NOW = 1_000_000_000;
const policy = { intermediateAfterMs: 1000, purgeAfterMs: 10_000 };

const ws = (over: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  sessionId: "s1",
  lastActiveAt: NOW,
  finished: true,
  ...over,
});

describe("decideGc", () => {
  it("刚活动过 → 保留", () => {
    expect(decideGc(ws(), policy, NOW)).toBe("keep");
  });

  it("结束且过了中间产物期 → 清中间产物", () => {
    expect(decideGc(ws(), policy, NOW + 1500)).toBe("clean-intermediate");
  });

  it("过了保留期 → 清整个目录", () => {
    expect(decideGc(ws(), policy, NOW + 20_000)).toBe("purge");
  });

  it("未结束的会话不清中间产物(正在跑的任务需要它们)", () => {
    expect(decideGc(ws({ finished: false }), policy, NOW + 1500)).toBe("keep");
  });

  it("未结束但超过保留期仍会清 —— 兜底防僵尸会话占盘", () => {
    expect(decideGc(ws({ finished: false }), policy, NOW + 20_000)).toBe("purge");
  });

  it("边界:刚好到中间产物期即触发", () => {
    expect(decideGc(ws(), policy, NOW + 1000)).toBe("clean-intermediate");
  });

  it("边界:刚好到保留期即清目录", () => {
    expect(decideGc(ws(), policy, NOW + 10_000)).toBe("purge");
  });

  it("默认策略:1 小时清中间产物、7 天清目录", () => {
    expect(DEFAULT_GC_POLICY.intermediateAfterMs).toBe(3_600_000);
    expect(DEFAULT_GC_POLICY.purgeAfterMs).toBe(604_800_000);
  });
});

describe("isIntermediate", () => {
  it("识别常见临时目录", () => {
    expect(isIntermediate("node_modules")).toBe(true);
    expect(isIntermediate("__pycache__")).toBe(true);
    expect(isIntermediate(".venv")).toBe(true);
    expect(isIntermediate(".cache")).toBe(true);
    expect(isIntermediate("tmp")).toBe(true);
  });

  it("识别临时/日志文件后缀", () => {
    expect(isIntermediate("build.tmp")).toBe(true);
    expect(isIntermediate("run.log")).toBe(true);
    expect(isIntermediate("mod.pyc")).toBe(true);
  });

  it("不动用户可能要的产出", () => {
    expect(isIntermediate("report.md")).toBe(false);
    expect(isIntermediate("output.mp4")).toBe(false);
    expect(isIntermediate("data.json")).toBe(false);
    expect(isIntermediate("main.py")).toBe(false);
    // 名字里带 tmp 但不是临时物
    expect(isIntermediate("tmpfile-important.md")).toBe(false);
  });
});
