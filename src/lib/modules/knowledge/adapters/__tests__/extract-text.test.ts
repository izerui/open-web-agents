// 上传文件提取文字:用现场打包的真实结构文件(docx / pptx / xlsx)与手写 PDF 验证,
// 包括不嵌入字体、靠 CMap 编码的中文 PDF(老的中文公文、教材常见),以及各种该拒绝的情况。
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { columnOf } from "../extract-child.mjs";
import { EXTRACT_LIMITS, extractText, liveExtractionWorkers } from "../extract-text";
import { docx, heavyDocx, pdf, pptx, xlsx, xlsxWithGaps } from "./fixtures/make";

const ok = async (name: string, bytes: Uint8Array) => {
  const r = await extractText(name, bytes);
  if (!r.ok) throw new Error(`应当成功:${r.reason}`);
  return r;
};
const reason = async (name: string, bytes: Uint8Array, limits = EXTRACT_LIMITS) => {
  const r = await extractText(name, bytes, limits);
  if (r.ok) throw new Error("应当拒绝");
  return r.reason;
};

describe("extractText", () => {
  it("Word:按段落,解开 XML 转义", async () => {
    const r = await ok("制度.docx", docx(["第一条 总则", "报销 &amp; 审批 &lt;试行&gt;"]));
    expect(r).toMatchObject({ format: "docx", text: "第一条 总则\n报销 & 审批 <试行>" });
  });

  it("PPT:按幻灯片顺序(第 10 页排在第 2 页之后),标出页码", async () => {
    const slides = Array.from({ length: 10 }, (_, i) => [`标题${i + 1}`, `要点${i + 1}`]);
    const r = await ok("课件.pptx", pptx(slides));
    expect(r.format).toBe("pptx");
    expect(r.pages).toBe(10);
    expect(r.text.indexOf("第 2 页\n标题2")).toBeLessThan(r.text.indexOf("第 10 页\n标题10"));
  });

  it("Excel:按工作表,每行一行、单元格用制表符;共享字符串、内联字符串与数字", async () => {
    const r = await ok("成绩.xlsx", xlsx());
    expect(r.text).toBe("工作表:成绩\n姓名\t分数\n张三\t95.5\n\n工作表:说明&备注\n满分 100");
  });

  it("PDF:普通字体;不嵌入字体、靠 CMap 编码的中文也能取出", async () => {
    expect((await ok("a.pdf", pdf("Hello PDF"))).text).toBe("Hello PDF");
    const cjk = await ok("教材.pdf", pdf("中文资料测试", { cjk: true }));
    expect(cjk).toMatchObject({ format: "pdf", pages: 1, text: "中文资料测试" });
  });

  it("纯文本:UTF-8(去 BOM)与 GBK 都能读", async () => {
    expect((await ok("a.txt", strToU8("\uFEFF说明\r\n第二行  \n\n\n\n第三行"))).text).toBe(
      "说明\n第二行\n\n第三行",
    );
    const gbk = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]); // "中文" 的 GBK 编码
    expect((await ok("旧.txt", gbk)).text).toBe("中文");
  });

  it("该拒绝的:扫描版 PDF、旧版 Office、非 Office 压缩包、改了扩展名的二进制、空文件、超大、解压炸弹", async () => {
    expect(await reason("扫描.pdf", pdf("", { empty: true }))).toContain("扫描件");
    const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]);
    expect(await reason("旧.doc", ole)).toContain("另存为 .docx");
    expect(await reason("包.zip", zipSync({ "a.txt": strToU8("x") }))).toContain(
      "不是 Office 文档",
    );
    expect(await reason("假.txt", Uint8Array.from([0x41, 0, 0x42]))).toContain("不是文本文件");
    expect(await reason("程序.exe", Uint8Array.from([0x4d, 0x5a, 1, 2]))).toContain(
      "不支持的文件类型",
    );
    expect(await reason("空.txt", new Uint8Array())).toContain("空的");
    expect(
      await reason("大.txt", strToU8("x".repeat(2000)), { ...EXTRACT_LIMITS, maxBytes: 1000 }),
    ).toContain("上限");
    const bomb = docx(["a".repeat(200_000)]);
    expect(bomb.length).toBeLessThan(5_000);
    expect(
      await reason("炸弹.docx", bomb, { ...EXTRACT_LIMITS, maxUnzippedBytes: 50_000 }),
    ).toContain("解压后过大");
  });

  it("损坏的文件:给出原因,不抛错", async () => {
    const broken = docx(["x"]).slice(0, 60);
    expect(await reason("坏.docx", broken)).toMatch(/损坏|不是 Office/);
    expect(await reason("坏.pdf", strToU8("%PDF-1.4\n垃圾"))).toMatch(/损坏|没有可提取/);
  });

  it("Excel 有空单元格:按坐标放进对应的列,不往前挤(缺 B2 时 95 仍在数学列)", async () => {
    const r = await ok("成绩.xlsx", xlsxWithGaps());
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("工作表:成绩");
    expect(lines[1]).toBe("姓名\t语文\t数学");
    expect(lines[2]).toBe("张三\t\t95");
    expect(lines[2]?.split("\t")[2]).toBe("95"); // 第 3 列 = 数学
    expect(lines[3]).toBe("李四\t88\t90"); // 没写坐标的按顺序排
    expect(lines[4]?.split("\t")).toHaveLength(28); // AB 是第 28 列
    expect(lines[4]?.endsWith("\t备注")).toBe(true);
  });

  it("列坐标换算", () => {
    expect([
      columnOf("A1"),
      columnOf("C2"),
      columnOf("Z9"),
      columnOf("AA10"),
      columnOf("AB4"),
    ]).toEqual([0, 2, 25, 26, 27]);
    expect(columnOf(undefined)).toBeNull();
  });
});

describe("extractText:时限与内存真的停下解析(独立子进程)", { timeout: 60_000 }, () => {
  /** 主线程在这段时间里还能不能跑计时器:同步解析放在主线程时,这里一次都跑不到 */
  async function ticksDuring<T>(p: Promise<T>): Promise<{ value: T; ticks: number; ms: number }> {
    let ticks = 0;
    const t = setInterval(() => {
      ticks++;
    }, 10);
    const start = Date.now();
    try {
      const value = await p;
      return { value, ticks, ms: Date.now() - start };
    } finally {
      clearInterval(t);
    }
  }
  const settle = async () => {
    for (let i = 0; i < 100 && liveExtractionWorkers() > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("超时:到点就返回,解析期间当前进程照常响应;子进程确实退出;之后的解析照常", async () => {
    const heavy = heavyDocx();
    expect(heavy.length).toBeLessThan(EXTRACT_LIMITS.maxBytes);
    const { value, ticks, ms } = await ticksDuring(
      extractText("大.docx", heavy, { ...EXTRACT_LIMITS, timeoutMs: 300 }),
    );
    expect(value).toMatchObject({ ok: false });
    expect(value.ok === false && value.reason).toContain("已停止解析");
    expect(ms).toBeLessThan(2_000);
    expect(ticks).toBeGreaterThan(10);
    await settle();
    expect(liveExtractionWorkers()).toBe(0);
    expect((await ok("后续.docx", docx(["照常解析"]))).text).toBe("照常解析");
    await settle();
    expect(liveExtractionWorkers()).toBe(0);
  });

  it("内存超限:只有解析子进程退出,给出原因;当前进程不受影响", async () => {
    const r = await extractText("大.docx", heavyDocx(), { ...EXTRACT_LIMITS, maxHeapMb: 16 });
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.reason).toContain("内存上限");
    await settle();
    expect(liveExtractionWorkers()).toBe(0);
    expect((await ok("后续.txt", strToU8("照常"))).text).toBe("照常");
  });
});
