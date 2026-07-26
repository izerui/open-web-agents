// 真实文件系统测试:在临时目录里造工作空间,验证列举/预览/穿越防护。

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalFsStorage } from "@/lib/modules/artifacts/adapters/local-fs-storage";
import { PathEscapeError } from "@/lib/modules/artifacts/domain/safe-path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let root: string;
let ws: string;
const storage = new LocalFsStorage();

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "owa-fs-"));
  ws = path.join(root, "workspaces", "s1");
  await fs.mkdir(path.join(ws, "sub"), { recursive: true });
  await fs.writeFile(path.join(ws, "report.md"), "# 标题\n正文");
  await fs.writeFile(path.join(ws, "data.json"), '{"a":1}');
  await fs.writeFile(path.join(ws, ".hidden"), "secret");
  await fs.writeFile(path.join(ws, "sub", "nested.txt"), "深层");
  await fs.writeFile(path.join(ws, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // 工作空间之外的"邻居",穿越测试的目标
  await fs.mkdir(path.join(root, "workspaces", "s2"), { recursive: true });
  await fs.writeFile(path.join(root, "workspaces", "s2", "secret.txt"), "别人的数据");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("LocalFsStorage.tree", () => {
  it("列出根目录,目录在前", async () => {
    const nodes = await storage.tree(ws, "");
    expect(nodes[0]?.type).toBe("dir");
    expect(nodes.map((n) => n.name)).toEqual(["sub", "data.json", "pic.png", "report.md"]);
  });

  it("隐藏点开头的内部产物", async () => {
    const nodes = await storage.tree(ws, "");
    expect(nodes.some((n) => n.name === ".hidden")).toBe(false);
  });

  it("文件带大小与修改时间", async () => {
    const nodes = await storage.tree(ws, "");
    const md = nodes.find((n) => n.name === "report.md");
    expect(md?.size).toBeGreaterThan(0);
    expect(md?.mtime).toBeGreaterThan(0);
  });

  it("列子目录,path 为相对工作空间的路径", async () => {
    const nodes = await storage.tree(ws, "sub");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.path).toBe("sub/nested.txt");
  });

  it("挡住穿越到邻居工作空间", async () => {
    await expect(storage.tree(ws, "../s2")).rejects.toThrow(PathEscapeError);
  });
});

describe("LocalFsStorage.preview", () => {
  it("文本文件回内容", async () => {
    const p = await storage.preview(ws, "report.md");
    expect(p.mime).toBe("text/markdown");
    expect(p.text).toContain("# 标题");
    expect(p.truncated).toBe(false);
  });

  it("json 也当文本预览", async () => {
    expect((await storage.preview(ws, "data.json")).text).toBe('{"a":1}');
  });

  it("二进制不回内容,只给元信息", async () => {
    const p = await storage.preview(ws, "pic.png");
    expect(p.mime).toBe("image/png");
    expect(p.text).toBeNull();
    expect(p.size).toBe(4);
  });

  it("挡住穿越读取工作空间外的文件", async () => {
    await expect(storage.preview(ws, "../s2/secret.txt")).rejects.toThrow(PathEscapeError);
  });

  it("不存在的文件抛 ENOENT", async () => {
    await expect(storage.preview(ws, "nope.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("LocalFsStorage.read", () => {
  it("回原始字节与 mime", async () => {
    const { bytes, mime } = await storage.read(ws, "pic.png");
    expect(mime).toBe("image/png");
    expect(bytes.length).toBe(4);
  });

  it("挡住穿越下载", async () => {
    await expect(storage.read(ws, "../s2/secret.txt")).rejects.toThrow(PathEscapeError);
  });
});

// 符号链接逃逸。
//
// safe-path 的文件头写着能挡住「符号链接式拼接」,但它是纯路径计算 ——
// path.resolve 不跟随符号链接,判定结果永远是「在工作区内」,而随后的 fs.readFile 跟随。
// agent 只要在自己工作目录里 `ln -s / root_link`,`?download=root_link/etc/passwd`
// 就能读到宿主根下的任意文件:/proc/self/environ 里有 OWA_SECRET_KEY 与数据库连接串,
// 其它租户的产物也一并暴露。全仓 grep realpath 曾经零命中 —— 注释承诺了没做到的事。
//
// 判定符号链接必然要碰 IO,所以守卫只能落在适配器层。
describe("LocalFsStorage / 【符号链接回归】真实路径必须仍在工作空间内", () => {
  let linked: string;

  beforeAll(async () => {
    linked = path.join(ws, "escape_link");
    // 指向工作空间之外的邻居目录
    await fs.symlink(path.join(root, "workspaces", "s2"), linked, "dir").catch(() => {});
  });

  it("顺着符号链接读别人的文件要拒", async () => {
    await expect(storage.read(ws, "escape_link/secret.txt")).rejects.toThrow(PathEscapeError);
  });

  it("顺着符号链接预览要拒", async () => {
    await expect(storage.preview(ws, "escape_link/secret.txt")).rejects.toThrow(PathEscapeError);
  });

  it("顺着符号链接列目录要拒", async () => {
    await expect(storage.tree(ws, "escape_link")).rejects.toThrow(PathEscapeError);
  });

  it("指向工作空间【内部】的符号链接仍然可用 —— 不误伤正常用法", async () => {
    const inner = path.join(ws, "inner_link");
    await fs.symlink(path.join(ws, "sub"), inner, "dir").catch(() => {});
    const nodes = await storage.tree(ws, "inner_link");
    expect(nodes.map((n) => n.name)).toContain("nested.txt");
  });
});
