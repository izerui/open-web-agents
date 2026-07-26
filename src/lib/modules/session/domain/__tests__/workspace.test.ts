import path from "node:path";
import { isSafeSessionId, workspacePathFor } from "@/lib/modules/session/domain/workspace";
import { describe, expect, it } from "vitest";

describe("isSafeSessionId", () => {
  it("接受常见 id 形态", () => {
    expect(isSafeSessionId("abc123")).toBe(true);
    expect(isSafeSessionId("sess_01-XY")).toBe(true);
  });
  it("拒绝路径穿越与分隔符", () => {
    expect(isSafeSessionId("..")).toBe(false);
    expect(isSafeSessionId("../etc")).toBe(false);
    expect(isSafeSessionId("a/b")).toBe(false);
    expect(isSafeSessionId("a\\b")).toBe(false);
  });
  it("拒绝空与超长", () => {
    expect(isSafeSessionId("")).toBe(false);
    expect(isSafeSessionId("x".repeat(65))).toBe(false);
  });
  it("拒绝空格与特殊字符", () => {
    expect(isSafeSessionId("a b")).toBe(false);
    expect(isSafeSessionId("a;rm -rf")).toBe(false);
  });
});

describe("workspacePathFor", () => {
  it("落在 dataDir/workspaces/<id> 下且为绝对路径", () => {
    const p = workspacePathFor("/data", "s1");
    expect(p).toBe(path.resolve("/data/workspaces/s1"));
    expect(path.isAbsolute(p)).toBe(true);
  });

  it("挡住路径穿越", () => {
    expect(() => workspacePathFor("/data", "../../etc")).toThrow(/unsafe/i);
    expect(() => workspacePathFor("/data", "..")).toThrow(/unsafe/i);
  });

  it("挡住绝对路径注入", () => {
    expect(() => workspacePathFor("/data", "/etc/passwd")).toThrow(/unsafe/i);
  });

  it("不同会话目录互不重叠", () => {
    expect(workspacePathFor("/data", "s1")).not.toBe(workspacePathFor("/data", "s2"));
  });
});
