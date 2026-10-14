import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalFsStorage } from "@/lib/modules/artifacts/adapters/local-fs-storage";
import { listTaskFiles, taskFilesForResult } from "@/lib/modules/artifacts/application/task-files";
import { beforeAll, describe, expect, it } from "vitest";

let ws: string;
const storage = new LocalFsStorage();

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "owa-taskfiles-"));
  await fs.mkdir(path.join(ws, "out", "deep"), { recursive: true });
  await fs.writeFile(path.join(ws, "report.md"), "# r");
  await fs.writeFile(path.join(ws, "out", "data.csv"), "a,b\n1,2\n");
  await fs.writeFile(path.join(ws, "out", "deep", "x.txt"), "x");
  await fs.mkdir(path.join(ws, ".claude"), { recursive: true });
  await fs.writeFile(path.join(ws, ".claude", "secret"), "hidden");
});

describe("listTaskFiles", () => {
  it("递归列出文件(隐藏项不列),附大小与下载路径;浅层在前", async () => {
    const r = await listTaskFiles(storage, { sessionId: "s 1", workspaceDir: ws });
    expect(r.truncated).toBe(false);
    expect(r.files.map((f) => f.path)).toEqual(["report.md", "out/data.csv", "out/deep/x.txt"]);
    expect(r.files[1]).toEqual({
      path: "out/data.csv",
      size: 8,
      download: "/api/sessions/s%201/files?download=out%2Fdata.csv",
    });
  });

  it("超过条数或深度上限:如实标 truncated", async () => {
    expect(
      await listTaskFiles(storage, { sessionId: "s", workspaceDir: ws }, { maxFiles: 2 }),
    ).toMatchObject({
      truncated: true,
      files: [{ path: "report.md" }, { path: "out/data.csv" }],
    });
    const shallow = await listTaskFiles(
      storage,
      { sessionId: "s", workspaceDir: ws },
      { maxDepth: 2 },
    );
    expect(shallow.truncated).toBe(true);
    expect(shallow.files.map((f) => f.path)).toEqual(["report.md", "out/data.csv"]);
  });

  it("工作目录不存在(已被清理):空清单,不报错", async () => {
    expect(
      await listTaskFiles(storage, { sessionId: "s", workspaceDir: path.join(ws, "nope") }),
    ).toEqual({ files: [], truncated: false });
  });
});

describe("taskFilesForResult", () => {
  it("查工作目录的那一步永不返回:在上限内给 null,不拖住结果", async () => {
    const t0 = Date.now();
    const r = await taskFilesForResult(storage, () => new Promise(() => {}), 200);
    expect(r).toEqual({ files: null, filesTruncated: false });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("列目录出错:null;会话不存在:null;正常:清单", async () => {
    const broken = { tree: async () => Promise.reject(new Error("EIO")) };
    expect(
      (await taskFilesForResult(broken, { sessionId: "s", workspaceDir: ws })).files,
    ).toBeNull();
    expect((await taskFilesForResult(storage, null)).files).toBeNull();
    expect(
      (await taskFilesForResult(storage, async () => ({ sessionId: "s", workspaceDir: ws }))).files
        ?.length,
    ).toBe(3);
  });
});
