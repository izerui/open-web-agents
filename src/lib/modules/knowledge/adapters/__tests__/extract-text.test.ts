// 上传文件提取文字:用现场打包的真实结构文件(docx / pptx / xlsx)与手写 PDF 验证,
// 包括不嵌入字体、靠 CMap 编码的中文 PDF(老的中文公文、教材常见),以及各种该拒绝的情况。
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { EXTRACT_LIMITS, extractText } from "../extract-text";
import { docx, pdf, pptx, xlsx } from "./fixtures/make";

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
});
