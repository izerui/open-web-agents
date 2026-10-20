import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsCostOutbox } from "../fs-cost-outbox";

describe("FsCostOutbox", () => {
  let dir: string;
  beforeEach(async () => {
    dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "owa-outbox-")), "cost-outbox");
  });
  afterEach(async () => {
    await fs.rm(path.dirname(dir), { recursive: true, force: true });
  });

  it("写入、覆盖、列出、删除;目录不存在时列出为空,删除不存在的也成功", async () => {
    const box = new FsCostOutbox(dir);
    expect(await box.list()).toEqual([]);
    await box.save("r1", { input: 1 });
    await box.save("r1", { input: 2 });
    await box.save("r2", { input: 3 });
    expect((await box.list()).sort((a, b) => a.runId.localeCompare(b.runId))).toEqual([
      { runId: "r1", cost: { input: 2 } },
      { runId: "r2", cost: { input: 3 } },
    ]);
    await box.remove("r1");
    await box.remove("r1");
    expect(await box.list()).toEqual([{ runId: "r2", cost: { input: 3 } }]);
    // 不留临时文件
    expect((await fs.readdir(dir)).filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("没写完的临时文件忽略;损坏的文件跳过并报告,不挡住其他的", async () => {
    const errors: string[] = [];
    const box = new FsCostOutbox(dir, (m) => errors.push(m));
    await box.save("good", { input: 1 });
    await fs.writeFile(path.join(dir, ".half.123.tmp"), "{");
    await fs.writeFile(path.join(dir, "broken.json"), "{not json");
    await fs.writeFile(
      path.join(dir, "mismatch.json"),
      JSON.stringify({ runId: "other", cost: {} }),
    );
    expect(await box.list()).toEqual([{ runId: "good", cost: { input: 1 } }]);
    expect(errors).toHaveLength(2);
  });

  it("运行 id 不合法(可能拼出目录之外):拒绝", async () => {
    const box = new FsCostOutbox(dir);
    await expect(box.save("../x", {})).rejects.toThrow(/不合法/);
    await expect(box.remove("a/b")).rejects.toThrow(/不合法/);
  });
});
