import type { AgentEvent } from "@/lib/shared";
import { describe, expect, it } from "vitest";
import { latestFile, stepLabel, workStatus, workSteps } from "../recent-work";

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

describe("workSteps:正在工作卡片的步骤进度", () => {
  const use = (tool: string, input: unknown, toolUseId: string): AgentEvent => ({
    kind: "tool_use",
    tool,
    input,
    toolUseId,
  });
  const done = (toolUseId: string, isError = false): AgentEvent => ({
    kind: "tool_result",
    toolUseId,
    text: "ok",
    isError,
  });

  it("没有工具调用时为空", () => {
    expect(workSteps([{ kind: "text", text: "你好" }])).toEqual([]);
  });

  it("取最近 3 条工具调用:有结果的打勾,最后一条还没结果的是当前步骤", () => {
    const steps = workSteps([
      use("Read", { file_path: "/w/a.md" }, "1"),
      done("1"),
      use("Grep", { pattern: "报销" }, "2"),
      done("2"),
      use("Bash", { command: "python x.py", description: "汇总金额" }, "3"),
      done("3", true),
      use("Write", { file_path: "/w/out/纪要.md" }, "4"),
    ]);
    expect(steps).toEqual([
      { label: "搜索「报销」", state: "done" },
      { label: "汇总金额", state: "error" },
      { label: "写入 纪要.md", state: "running" },
    ]);
  });

  it("有计划(TodoWrite)时按最新计划显示:当前步骤前后共 3 条", () => {
    const steps = workSteps([
      use("Read", { file_path: "a" }, "1"),
      use(
        "TodoWrite",
        {
          todos: [
            { content: "读取录音转写", status: "completed", activeForm: "正在读取录音转写" },
            { content: "提炼决议", status: "completed", activeForm: "正在提炼决议" },
            { content: "整理待办", status: "in_progress", activeForm: "正在整理待办" },
            { content: "生成纪要", status: "pending", activeForm: "正在生成纪要" },
            { content: "发给参会人", status: "pending", activeForm: "正在发送" },
          ],
        },
        "2",
      ),
    ]);
    expect(steps).toEqual([
      { label: "提炼决议", state: "done" },
      { label: "整理待办", state: "running" },
      { label: "生成纪要", state: "pending" },
    ]);
  });

  it("提问、计划本身不算一步;子智能体里的调用也不算", () => {
    const steps = workSteps([
      use("AskUserQuestion", {}, "1"),
      { kind: "tool_use", tool: "Read", input: { file_path: "x" }, toolUseId: "9", subagent: "s" },
      use("WebSearch", { query: "差旅标准" }, "2"),
    ]);
    expect(steps).toEqual([{ label: "搜索网页「差旅标准」", state: "running" }]);
  });
});

describe("stepLabel", () => {
  it("常见工具翻成中文,长内容截断", () => {
    expect(stepLabel("Read", { file_path: "/a/b/c.ts" })).toBe("读取 c.ts");
    expect(stepLabel("Edit", { file_path: "c.ts" })).toBe("修改 c.ts");
    expect(stepLabel("Glob", { pattern: "**/*.md" })).toBe("查找文件 **/*.md");
    expect(stepLabel("WebFetch", { url: "https://example.com/x" })).toBe("打开网页 example.com");
    expect(stepLabel("Task", { description: "核对发票" })).toBe("交给子智能体：核对发票");
    expect(stepLabel("mcp__erp__submit", {})).toBe("调用 erp.submit");
    expect(stepLabel("Bash", { command: "ls -la" })).toBe("运行命令 ls -la");
    expect(stepLabel("Whatever", null)).toBe("调用 Whatever");
    expect(stepLabel("Bash", { command: "x".repeat(200) }).length).toBeLessThanOrEqual(60);
  });
});
