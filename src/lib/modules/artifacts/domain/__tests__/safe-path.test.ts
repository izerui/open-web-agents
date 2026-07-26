import path from "node:path";
import {
  PathEscapeError,
  isHiddenEntry,
  resolveInWorkspace,
} from "@/lib/modules/artifacts/domain/safe-path";
import { describe, expect, it } from "vitest";

const WS = "/data/workspaces/s1";

describe("resolveInWorkspace", () => {
  it("解析普通相对路径", () => {
    expect(resolveInWorkspace(WS, "a.txt")).toBe(path.resolve(`${WS}/a.txt`));
  });

  it("解析嵌套路径", () => {
    expect(resolveInWorkspace(WS, "sub/dir/b.md")).toBe(path.resolve(`${WS}/sub/dir/b.md`));
  });

  it("空路径与 . 返回工作空间根", () => {
    expect(resolveInWorkspace(WS, "")).toBe(path.resolve(WS));
    expect(resolveInWorkspace(WS, ".")).toBe(path.resolve(WS));
  });

  it("挡住 .. 穿越", () => {
    expect(() => resolveInWorkspace(WS, "../s2/secret")).toThrow(PathEscapeError);
    expect(() => resolveInWorkspace(WS, "..")).toThrow(PathEscapeError);
    expect(() => resolveInWorkspace(WS, "a/../../b")).toThrow(PathEscapeError);
  });

  it("挡住深层 .. 穿越到系统目录", () => {
    expect(() => resolveInWorkspace(WS, "../../../../etc/passwd")).toThrow(PathEscapeError);
  });

  it("挡住绝对路径注入", () => {
    expect(() => resolveInWorkspace(WS, "/etc/passwd")).toThrow(PathEscapeError);
  });

  it("挡住看着像前缀的兄弟目录(字符串前缀比较会漏)", () => {
    // /data/workspaces/s1-evil 以 /data/workspaces/s1 为字符串前缀,但不在其内
    expect(() => resolveInWorkspace(WS, "../s1-evil/x")).toThrow(PathEscapeError);
  });

  it("内部先上后下但最终仍在根内则放行", () => {
    expect(resolveInWorkspace(WS, "sub/../a.txt")).toBe(path.resolve(`${WS}/a.txt`));
  });

  it("挡住穿越尝试时错误信息带上原始输入,便于排查", () => {
    expect(() => resolveInWorkspace(WS, "../x")).toThrow(/\.\.\/x/);
  });
});

describe("isHiddenEntry", () => {
  it("点开头视为隐藏", () => {
    expect(isHiddenEntry(".agent-home")).toBe(true);
    expect(isHiddenEntry(".DS_Store")).toBe(true);
  });
  it("普通文件不隐藏", () => {
    expect(isHiddenEntry("report.md")).toBe(false);
  });
});
