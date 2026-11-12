import { describe, expect, it } from "vitest";
import { latestFile, workStatus } from "../recent-work";

describe("workStatus", () => {
  it("排队与执行中都算运行中", () => {
    expect(workStatus("pending", null)).toBe("running");
    expect(workStatus("running", { name: "a.md" })).toBe("running");
  });
  it("成功且有文件 = 成果已交付;成功没文件 = 已回复", () => {
    expect(workStatus("success", { name: "纪要.md" })).toBe("delivered");
    expect(workStatus("success", null)).toBe("replied");
  });
  it("失败、已停止、还没跑过", () => {
    expect(workStatus("failed", { name: "a.md" })).toBe("failed");
    expect(workStatus("cancelled", null)).toBe("cancelled");
    expect(workStatus(undefined, null)).toBe("idle");
  });
});

describe("latestFile", () => {
  it("只取文件、跳过隐藏项与目录,取最近修改的", () => {
    expect(
      latestFile([
        { path: "old.md", name: "old.md", type: "file", size: 10, mtime: 100 },
        { path: "out", name: "out", type: "dir", mtime: 999 },
        { path: ".claude", name: ".claude", type: "dir", mtime: 999 },
        { path: ".hidden.txt", name: ".hidden.txt", type: "file", mtime: 998 },
        { path: "新.csv", name: "新.csv", type: "file", size: 20, mtime: 300 },
        { path: "mid.txt", name: "mid.txt", type: "file", mtime: 200 },
      ]),
    ).toEqual({ name: "新.csv", path: "新.csv", size: 20, mtime: 300 });
  });
  it("早于 since 的文件不算这次的成果", () => {
    expect(
      latestFile([{ path: "a.md", name: "a.md", type: "file", mtime: 100 }], { since: 200 }),
    ).toBeNull();
  });
  it("没有文件时为 null", () => {
    expect(latestFile([])).toBeNull();
    expect(latestFile([{ path: "d", name: "d", type: "dir" }])).toBeNull();
  });
});
