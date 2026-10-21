// 上传到知识库的文件 → 纯文本。只存提取出的文字,不存原文件。
//
// 支持:PDF(pdf.js)、Word / PPT / Excel 的新格式(.docx .pptx .xlsx,都是 zip 里的 XML,解压后自取文字)、
// 纯文本(.txt .md .csv,UTF-8 或 GBK)。旧的二进制 Office 格式、扫描版 PDF、加密文件给出原因拒绝。
//
// 【按文件头判断真实格式,不信扩展名】改了扩展名的文件按真实内容处理或拒绝,不会把 zip 当文本存进去。
// 【都有上限】文件大小、PDF 页数、解压后的总大小(防 zip 炸弹)、解析时长 —— 一个恶意文件不能拖垮 web 进程。

import { createRequire } from "node:module";
import path from "node:path";
import { unzipSync } from "fflate";

export interface ExtractLimits {
  maxBytes: number;
  maxPdfPages: number;
  /** zip 里要读的那些 XML 解压后合计的上限 */
  maxUnzippedBytes: number;
  timeoutMs: number;
}

export const EXTRACT_LIMITS: ExtractLimits = {
  maxBytes: 20 * 1024 * 1024,
  maxPdfPages: 500,
  maxUnzippedBytes: 100 * 1024 * 1024,
  timeoutMs: 60_000,
};

export type ExtractResult =
  | { ok: true; text: string; format: "pdf" | "docx" | "pptx" | "xlsx" | "text"; pages?: number }
  | { ok: false; reason: string };

class Rejected extends Error {}

const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log"]);
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);

export async function extractText(
  fileName: string,
  bytes: Uint8Array,
  limits: ExtractLimits = EXTRACT_LIMITS,
): Promise<ExtractResult> {
  const ext = path.extname(fileName).toLowerCase();
  if (bytes.length === 0) return { ok: false, reason: "文件是空的" };
  if (bytes.length > limits.maxBytes) {
    return { ok: false, reason: `文件超过 ${Math.round(limits.maxBytes / 1024 / 1024)}MB 上限` };
  }
  try {
    const result = await withTimeout(extractByContent(ext, bytes, limits), limits.timeoutMs);
    const text = tidy(result.text);
    if (!text) {
      return {
        ok: false,
        reason:
          result.format === "pdf"
            ? "PDF 里没有可提取的文字(可能是扫描件或图片),需要先做文字识别再上传"
            : "文件里没有可提取的文字",
      };
    }
    return { ok: true, ...result, text };
  } catch (err) {
    if (err instanceof Rejected) return { ok: false, reason: err.message };
    return {
      ok: false,
      reason: `无法读取文件内容(可能已损坏):${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
    };
  }
}

async function extractByContent(
  ext: string,
  bytes: Uint8Array,
  limits: ExtractLimits,
): Promise<Omit<Extract<ExtractResult, { ok: true }>, "ok">> {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return extractPdf(bytes, limits); // %PDF
  if (startsWith(bytes, OLE)) {
    throw new Rejected(
      "这是旧版 Office 格式(.doc / .ppt / .xls)或加密的 Office 文件,请另存为 .docx / .pptx / .xlsx 后再上传",
    );
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return extractOoxml(bytes, limits); // zip
  if (TEXT_EXT.has(ext)) return { format: "text", text: decodeText(bytes) };
  throw new Rejected(
    "不支持的文件类型:支持 PDF、Word(.docx)、PPT(.pptx)、Excel(.xlsx)和纯文本(.txt .md .csv)",
  );
}

// ─────────────────────────── 纯文本 ───────────────────────────

/** UTF-8 解不开就按 GB18030(含 GBK)—— Windows 上存的中文文本文件常是 GBK */
function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Rejected("这不是文本文件(含二进制内容)");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

// ─────────────────────────── PDF ───────────────────────────

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Promise<PdfJs> | null = null;
/**
 * pdf.js 的数据目录:CMap 缺了,未嵌入字体的中文 PDF 提取出来是空的。
 * 【以进程工作目录为基准解析】打包器会把 createRequire(import.meta.url) 改写成它自己的模块表,
 * resolve 返回的是模块编号而不是路径(构建后实测)。工作目录在开发与 standalone 部署时都是应用根
 */
const pdfjsDir = () => {
  const fromCwd = createRequire(path.join(process.cwd(), "package.json"));
  const resolved: unknown = fromCwd.resolve("pdfjs-dist/package.json");
  return typeof resolved === "string"
    ? path.dirname(resolved)
    : path.join(process.cwd(), "node_modules", "pdfjs-dist");
};

async function extractPdf(
  bytes: Uint8Array,
  limits: ExtractLimits,
): Promise<Omit<Extract<ExtractResult, { ok: true }>, "ok">> {
  pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  const lib = await pdfjs;
  const dir = pdfjsDir();
  const task = lib.getDocument({
    // pdf.js 会转移(detach)传入的缓冲区:给它一份拷贝
    data: new Uint8Array(bytes),
    cMapUrl: `${path.join(dir, "cmaps")}/`,
    cMapPacked: true,
    standardFontDataUrl: `${path.join(dir, "standard_fonts")}/`,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    if ((err as { name?: string })?.name === "PasswordException") {
      throw new Rejected("PDF 有密码保护,请去掉密码后再上传");
    }
    throw err;
  }
  try {
    if (doc.numPages > limits.maxPdfPages) {
      throw new Rejected(`PDF 超过 ${limits.maxPdfPages} 页,请拆分后再上传`);
    }
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join("\n"));
      page.cleanup();
    }
    return { format: "pdf", text: pages.join("\n\n"), pages: doc.numPages };
  } finally {
    await task.destroy().catch(() => {});
  }
}

// ─────────────────────────── Word / PPT / Excel(OOXML) ───────────────────────────

function unzipParts(
  bytes: Uint8Array,
  wanted: (name: string) => boolean,
  limits: ExtractLimits,
): Record<string, string> {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (f) => {
      if (!wanted(f.name)) return false;
      total += f.originalSize;
      if (total > limits.maxUnzippedBytes) {
        throw new Rejected("文件解压后过大,疑似异常文件");
      }
      return true;
    },
  });
  const out: Record<string, string> = {};
  let actual = 0;
  for (const [name, data] of Object.entries(files)) {
    actual += data.length;
    if (actual > limits.maxUnzippedBytes) throw new Rejected("文件解压后过大,疑似异常文件");
    out[name] = new TextDecoder("utf-8").decode(data);
  }
  return out;
}

function extractOoxml(
  bytes: Uint8Array,
  limits: ExtractLimits,
): Omit<Extract<ExtractResult, { ok: true }>, "ok"> {
  const types = unzipParts(bytes, (n) => n === "[Content_Types].xml", limits)[
    "[Content_Types].xml"
  ];
  if (!types) throw new Rejected("不是 Office 文档(zip 压缩包请解压后上传里面的文件)");
  if (types.includes("wordprocessingml.document.main")) {
    return {
      format: "docx",
      text: docxText(unzipParts(bytes, (n) => n === "word/document.xml", limits)),
    };
  }
  if (types.includes("presentationml.presentation.main")) {
    const parts = unzipParts(bytes, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n), limits);
    return { format: "pptx", ...pptxText(parts) };
  }
  if (types.includes("spreadsheetml.sheet.main")) {
    const parts = unzipParts(
      bytes,
      (n) =>
        n === "xl/workbook.xml" ||
        n === "xl/_rels/workbook.xml.rels" ||
        n === "xl/sharedStrings.xml" ||
        /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
      limits,
    );
    return { format: "xlsx", text: xlsxText(parts) };
  }
  throw new Rejected("不支持的 Office 文档类型:支持 .docx / .pptx / .xlsx");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? "";
  });
}

/** 一段 XML 里某个文本标签的全部文字(如 w:t、a:t),制表与换行标签换成对应字符 */
function runs(xml: string, tag: string): string {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>|<w:tab\\s*/>|<w:br\\s*/>|<a:br\\s*/>`,
    "g",
  );
  let out = "";
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) out += unescapeXml(m[1]);
    else out += m[0].includes("tab") ? "\t" : "\n";
  }
  return out;
}

function docxText(parts: Record<string, string>): string {
  const xml = parts["word/document.xml"];
  if (!xml) throw new Rejected("Word 文档缺少正文");
  return xml
    .split(/<\/w:p>/)
    .map((p) => runs(p, "w:t"))
    .join("\n");
}

function pptxText(parts: Record<string, string>): { text: string; pages: number } {
  const slides = Object.keys(parts)
    .map((n) => ({ n, i: Number(/slide(\d+)\.xml$/.exec(n)?.[1]) }))
    .sort((a, b) => a.i - b.i);
  const text = slides
    .map(({ n }, idx) => {
      const body = (parts[n] ?? "")
        .split(/<\/a:p>/)
        .map((p) => runs(p, "a:t"))
        .filter((l) => l.trim())
        .join("\n");
      return body ? `第 ${idx + 1} 页\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return { text, pages: slides.length };
}

function xlsxText(parts: Record<string, string>): string {
  const shared = [...(parts["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (m) => runs(m[1] ?? "", "t"),
  );
  // 工作表名 → 文件:workbook.xml 的 r:id 经 workbook.xml.rels 对到 worksheets/sheetN.xml
  const rels = new Map(
    [...(parts["xl/_rels/workbook.xml.rels"] ?? "").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      /Id="([^"]+)"/.exec(m[0])?.[1] ?? "",
      /Target="([^"]+)"/.exec(m[0])?.[1] ?? "",
    ]),
  );
  const sheets = [...(parts["xl/workbook.xml"] ?? "").matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const name = unescapeXml(/name="([^"]*)"/.exec(m[0])?.[1] ?? "");
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1] ?? "";
    const target = (rels.get(rid) ?? "").replace(/^\/?xl\//, "");
    return { name, file: `xl/${target}` };
  });
  const order = sheets.length
    ? sheets
    : Object.keys(parts)
        .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
        .map((file, i) => ({ name: `工作表${i + 1}`, file }));
  return order
    .map(({ name, file }) => {
      const xml = parts[file];
      if (!xml) return "";
      const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
        [...(r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map((c) => {
            const attrs = c[1] ?? "";
            const inner = c[2] ?? "";
            const t = /\st="([^"]+)"/.exec(attrs)?.[1];
            if (t === "inlineStr") return runs(inner, "t");
            const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
            if (v === undefined) return "";
            if (t === "s") return shared[Number(v)] ?? "";
            return unescapeXml(v);
          })
          .join("\t")
          .replace(/\t+$/, ""),
      );
      const body = rows.filter((r) => r.trim()).join("\n");
      return body ? `工作表:${name}\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

// ─────────────────────────── 公共 ───────────────────────────

/** 去掉 BOM、统一换行、行尾空白,连续空行压成一个 */
function tidy(s: string): string {
  return s
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00A0]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Rejected(`解析超过 ${Math.round(ms / 1000)} 秒,文件可能过于复杂`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
