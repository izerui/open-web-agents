// 知识库上传文件的解析,在独立的子进程里跑(由 extract-text.ts 用 child_process.fork 启动,超时直接杀掉)。
//
// 【为什么单独一个进程】解析是同步的重活(解压、在几十 MB 的 XML 上跑正则),放在 web 进程里,
// 计时器根本来不及触发,"超时"只是事后补一个错误,解析照样占满 web 进程;pdf.js 超时后也不会自己停。
// 【为什么不用 worker_threads】子线程的内存上限(resourceLimits)在大块分配时不可靠:实测 V8 直接
// 判整个进程内存耗尽(FATAL ERROR: Reached heap limit),主线程跟着崩。独立进程爆内存只死它自己。
// 入口必须是运行时按路径能找到的真实 JS 文件,所以用 .mjs 写,构建时显式带上(见 next.config.ts)。
//
// 支持:PDF(pdf.js,带 CMap)、.docx / .pptx / .xlsx(zip 里的 XML,解压后自取文字)、纯文本(UTF-8 / GBK)。
// 按文件头判断真实格式,不信扩展名。

import { createRequire } from "node:module";
import path from "node:path";
import { unzipSync } from "fflate";

class Rejected extends Error {}

const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log"]);
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (b, sig) => sig.every((v, i) => b[i] === v);

/** @returns {Promise<{format: string, text: string, pages?: number}>} */
async function extractByContent(ext, bytes, limits) {
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
function decodeText(bytes) {
  if (bytes.includes(0)) throw new Rejected("这不是文本文件(含二进制内容)");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

// ─────────────────────────── PDF ───────────────────────────

/**
 * pdf.js 的数据目录:CMap 缺了,未嵌入字体的中文 PDF 提取出来是空的。
 * 从本文件所在位置向上解析,开发与 standalone 部署都能找到 node_modules 里的 pdfjs-dist
 */
function pdfjsDir() {
  const req = createRequire(import.meta.url);
  return path.dirname(req.resolve("pdfjs-dist/package.json"));
}

async function extractPdf(bytes, limits) {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const dir = pdfjsDir();
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: `${path.join(dir, "cmaps")}/`,
    cMapPacked: true,
    standardFontDataUrl: `${path.join(dir, "standard_fonts")}/`,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    if (err?.name === "PasswordException") {
      throw new Rejected("PDF 有密码保护,请去掉密码后再上传");
    }
    throw err;
  }
  try {
    if (doc.numPages > limits.maxPdfPages) {
      throw new Rejected(`PDF 超过 ${limits.maxPdfPages} 页,请拆分后再上传`);
    }
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = "";
      const lines = [];
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

function unzipParts(bytes, wanted, limits) {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (f) => {
      if (!wanted(f.name)) return false;
      total += f.originalSize;
      if (total > limits.maxUnzippedBytes) throw new Rejected("文件解压后过大,疑似异常文件");
      return true;
    },
  });
  const out = {};
  let actual = 0;
  for (const [name, data] of Object.entries(files)) {
    actual += data.length;
    if (actual > limits.maxUnzippedBytes) throw new Rejected("文件解压后过大,疑似异常文件");
    out[name] = new TextDecoder("utf-8").decode(data);
  }
  return out;
}

function extractOoxml(bytes, limits) {
  const types = unzipParts(bytes, (n) => n === "[Content_Types].xml", limits)[
    "[Content_Types].xml"
  ];
  if (!types) throw new Rejected("不是 Office 文档(zip 压缩包请解压后上传里面的文件)");
  if (types.includes("wordprocessingml.document.main")) {
    const parts = unzipParts(bytes, (n) => n === "word/document.xml", limits);
    return { format: "docx", text: docxText(parts) };
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

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? "";
  });
}

/** 一段 XML 里某个文本标签的全部文字(如 w:t、a:t),制表与换行标签换成对应字符 */
function runs(xml, tag) {
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

function docxText(parts) {
  const xml = parts["word/document.xml"];
  if (!xml) throw new Rejected("Word 文档缺少正文");
  return xml
    .split(/<\/w:p>/)
    .map((p) => runs(p, "w:t"))
    .join("\n");
}

function pptxText(parts) {
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

/** 单元格坐标的列号(从 0 起):"A1"→0、"C2"→2、"AA10"→26;没有坐标返回 null */
export function columnOf(ref) {
  const letters = /^([A-Z]+)\d*$/i.exec(ref ?? "")?.[1];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel 一行最多补到这么多列:坐标被改成极大的列号时,不能为它铺出上万个空单元格 */
const MAX_COLUMNS = 16_384;

function xlsxText(parts) {
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
      const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
        // 【按坐标放进对应的列】空单元格在文件里通常根本不写:只按出现顺序拼,
        // "A2=张三、C2=95" 会拼成"张三\t95",95 就落到了 B 列。没写坐标的接着上一格往后排
        const cells = [];
        let next = 0;
        for (const c of (r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1] ?? "";
          const at = columnOf(/\sr="([^"]+)"/.exec(attrs)?.[1]) ?? next;
          if (at >= MAX_COLUMNS) continue;
          next = at + 1;
          const inner = c[2] ?? "";
          const t = /\st="([^"]+)"/.exec(attrs)?.[1];
          let value = "";
          if (t === "inlineStr") value = runs(inner, "t");
          else {
            const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
            if (v !== undefined) value = t === "s" ? (shared[Number(v)] ?? "") : unescapeXml(v);
          }
          cells[at] = value;
        }
        return Array.from(cells, (v) => v ?? "")
          .join("\t")
          .replace(/\t+$/, "");
      });
      const body = rows.filter((r) => r.trim()).join("\n");
      return body ? `工作表:${name}\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

// ─────────────────────────── 入口 ───────────────────────────

// 只在被 extract-text.ts 以解析子进程启动时接管消息 —— 测试里直接 import 本文件取函数时,
// 所在进程可能也有 IPC 通道(测试运行器的子进程),不能把它的消息当成解析任务
if (process.env.OWA_EXTRACT_CHILD === "1" && process.send) {
  process.once("message", (task) => {
    const { fileName, bytes, limits } = task;
    const ext = path.extname(fileName).toLowerCase();
    const reply = (m) => process.send?.(m, () => process.exit(0));
    extractByContent(ext, new Uint8Array(bytes), limits).then(
      (result) => reply({ ok: true, ...result }),
      (err) =>
        reply(
          err instanceof Rejected
            ? { ok: false, rejected: true, reason: err.message }
            : { ok: false, rejected: false, reason: String(err?.message ?? err).slice(0, 200) },
        ),
    );
  });
}
