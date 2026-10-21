// 上传文件提取文字:用现场打包的真实结构文件(docx / pptx / xlsx)与手写 PDF 验证,
// 包括不嵌入字体、靠 CMap 编码的中文 PDF(老的中文公文、教材常见),以及各种该拒绝的情况。
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { columnOf } from "../extract-child.mjs";
import { EXTRACT_LIMITS, extractText, liveExtractionWorkers } from "../extract-text";
import {
  docx,
  encodeLegacy,
  heavyDocx,
  pdf,
  pptx,
  pptxOrdered,
  utf16,
  xlsx,
  xlsxFormats,
  xlsxWithGaps,
} from "./fixtures/make";

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

  it("PPT 拖动过页面:按 presentation.xml 的展示顺序提取,页码跟着展示顺序,不按文件编号", async () => {
    // 文件 slide1 = 甲,slide2 = 乙;用户把乙拖到最前面:展示顺序是 slide2、slide1
    const swapped = pptxOrdered(
      [
        ["甲页标题", "甲页内容"],
        ["乙页标题", "乙页内容"],
      ],
      [2, 1],
    );
    const r = await ok("拖动过.pptx", swapped);
    expect(r).toMatchObject({ format: "pptx", pages: 2 });
    expect(r.text).toBe("第 1 页\n乙页标题\n乙页内容\n\n第 2 页\n甲页标题\n甲页内容");
    // 对照:没拖动过的照文件顺序
    const kept = await ok("没动过.pptx", pptxOrdered([["甲"], ["乙"]], [1, 2]));
    expect(kept.text).toBe("第 1 页\n甲\n\n第 2 页\n乙");
    // 留在压缩包里、但不在顺序表里的页(已从演示里删掉)不导入
    const dropped = await ok("删过页.pptx", pptxOrdered([["甲"], ["已删除"], ["丙"]], [3, 1]));
    expect(dropped).toMatchObject({ pages: 2, text: "第 1 页\n丙\n\n第 2 页\n甲" });
  });

  it("PPT 顺序表里的页解析不到(关系缺失、文件缺失、关系表缺失):拒绝整份文件并说明,不跳过后继续", async () => {
    const three = [["甲"], ["乙"], ["丙"]];
    const missingRel = await reason(
      "缺关系.pptx",
      pptxOrdered(three, [1, 2, 3], { missingRel: 2 }),
    );
    expect(missingRel).toContain("第 2 页");
    expect(missingRel).toContain("损坏");
    const missingFile = await reason(
      "缺文件.pptx",
      pptxOrdered(three, [3, 2, 1], { missingFile: 2 }),
    );
    expect(missingFile).toContain("第 2 页");
    expect(
      await reason("缺关系表.pptx", pptxOrdered(three, [1, 2, 3], { noRels: true })),
    ).toContain("损坏");
    // 对照:顺序表完整时交换顺序照常导入
    expect((await ok("正常.pptx", pptxOrdered(three, [3, 1, 2]))).text).toBe(
      "第 1 页\n丙\n\n第 2 页\n甲\n\n第 3 页\n乙",
    );
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

  it("文本编码:记事本存的 Unicode(UTF-16,有无 BOM)、GBK、Big5 都按原文读出;认不出的编码拒绝而不是存乱码", async () => {
    const zh = "差旅住宿标准:每晚不超过 450 元,需要附上发票和行程单。";
    const tw = "這是一段繁體中文的測試資料,我們要確認編碼判斷正確,不會變成亂碼。";
    expect((await ok("记事本.txt", utf16(zh, "le", true))).text).toBe(zh);
    expect((await ok("大端.txt", utf16(zh, "be", true))).text).toBe(zh);
    expect((await ok("无BOM.txt", utf16(zh, "le", false))).text).toBe(zh);
    expect((await ok("旧简体.txt", encodeLegacy(zh, "gb18030"))).text).toBe(zh);
    expect((await ok("繁體.txt", encodeLegacy(tw, "big5"))).text).toBe(tw);
    // 不是中文旧编码的非 UTF-8 文本(如 Windows-1252 的西文):认不出,拒绝并提示另存为 UTF-8
    const latin1 = Uint8Array.from("Café déjà vu, naïve façade résumé crème brûlée", (c) =>
      c.charCodeAt(0),
    );
    expect(await reason("西文.txt", latin1)).toContain("UTF-8");
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

  it("Excel 数字格式:日期、日期时间、时间、百分比按格式显示,不输出内部序号;浮点误差按常规格式;布尔值", async () => {
    const r = await ok("记录.xlsx", xlsxFormats());
    const [, row1, row2] = r.text.split("\n");
    expect(row1).toBe("2024-01-01\t2024-01-01 12:00\t18:00\t12.50%");
    // 0.30000000000000004 → 0.3;1900 闰年问题:序号 59 是 1900-02-28,61 是 1900-03-01
    expect(row2).toBe("0.3\tTRUE\t12345\t1900-02-28\t1900-03-01");
  });

  it("Excel 1904 日期系统:同一日期显示相同", async () => {
    const r = await ok("记录.xlsx", xlsxFormats({ date1904: true }));
    expect(r.text.split("\n")[1]).toBe("2024-01-01\t2024-01-01 12:00\t18:00\t12.50%");
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

  it("排队等名额的时间也算在时限里:名额被占满时,时限到了就返回,不等名额空出来;之后照常", async () => {
    const heavy = heavyDocx();
    const busy = [
      extractText("占名额1.docx", heavy, { ...EXTRACT_LIMITS, timeoutMs: 4_000 }),
      extractText("占名额2.docx", heavy, { ...EXTRACT_LIMITS, timeoutMs: 4_000 }),
    ];
    const start = Date.now();
    const queued = await extractText("排队.docx", docx(["小文件"]), {
      ...EXTRACT_LIMITS,
      timeoutMs: 300,
    });
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(queued).toMatchObject({ ok: false });
    expect(queued.ok === false && queued.reason).toContain("已停止解析");
    await Promise.all(busy);
    await settle();
    // 超时撤下的排队项不占后面的名额
    expect((await ok("之后.docx", docx(["照常"]))).text).toBe("照常");
  });

  it("取消:正在跑的解析子进程立刻被杀掉,返回已取消;排队中的撤出队列", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const start = Date.now();
    const running = await extractText(
      "很大.docx",
      heavyDocx(),
      { ...EXTRACT_LIMITS, timeoutMs: 30_000 },
      ac.signal,
    );
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(running).toMatchObject({ ok: false });
    expect(running.ok === false && running.reason).toContain("已取消");
    await settle();
    expect(liveExtractionWorkers()).toBe(0);
    const done = new AbortController();
    done.abort();
    expect(
      await extractText("已取消.docx", docx(["x"]), EXTRACT_LIMITS, done.signal),
    ).toMatchObject({ ok: false });
    expect((await ok("之后.docx", docx(["照常"]))).text).toBe("照常");
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
