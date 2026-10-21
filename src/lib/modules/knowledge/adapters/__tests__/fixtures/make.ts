// 测试用的最小真实文件:docx / pptx / xlsx 按 OOXML 结构现场打包,PDF 手写对象与交叉引用表。
import { strToU8, zipSync } from "fflate";

const enc = (s: string) => strToU8(s);

export function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join("");
  return zipSync({
    "[Content_Types].xml": enc(
      '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "word/document.xml": enc(`<w:document><w:body>${body}</w:body></w:document>`),
  });
}

/**
 * 带 presentation.xml 顺序表的 PPT:order 是展示顺序里各页对应的文件编号(从 1 起)。
 * 用户在 PowerPoint 里拖动页面后,文件 slideN.xml 不改名,只有 sldIdLst 的顺序变;
 * 关系表的 Target 混用相对与绝对路径,与真实文件一致
 */
export function pptxOrdered(
  slides: string[][],
  order: number[],
  /** 制造损坏:某页(文件编号)的关系条目缺失、目标文件缺失,或整个关系表缺失 */
  broken: { missingRel?: number; missingFile?: number; noRels?: boolean } = {},
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": enc(
      '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    ),
    "ppt/presentation.xml": enc(
      `<p:presentation><p:sldIdLst>${order
        .map((n, i) => `<p:sldId id="${256 + i}" r:id="rIdS${n}"/>`)
        .join("")}</p:sldIdLst></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": enc(
      `<Relationships><Relationship Id="rIdM" Type="slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides
        .map((_, i) => i)
        .filter((i) => broken.missingRel !== i + 1)
        .map(
          (i) =>
            `<Relationship Id="rIdS${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${i % 2 ? "/ppt/" : ""}slides/slide${i + 1}.xml"/>`,
        )
        .join("")}</Relationships>`,
    ),
  };
  slides.forEach((lines, i) => {
    if (broken.missingFile === i + 1) return;
    files[`ppt/slides/slide${i + 1}.xml`] = enc(
      `<p:sld><p:cSld><p:spTree>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join("")}</p:spTree></p:cSld></p:sld>`,
    );
  });
  if (broken.noRels) Reflect.deleteProperty(files, "ppt/_rels/presentation.xml.rels");
  return zipSync(files);
}

export function pptx(slides: string[][]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": enc(
      '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    ),
  };
  slides.forEach((lines, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = enc(
      `<p:sld><p:cSld><p:spTree>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join("")}</p:spTree></p:cSld></p:sld>`,
    );
  });
  return zipSync(files);
}

export function xlsx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": enc(
      '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    ),
    "xl/workbook.xml": enc(
      '<workbook><sheets><sheet name="成绩" sheetId="1" r:id="rId1"/><sheet name="说明&amp;备注" sheetId="2" r:id="rId2"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": enc(
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    ),
    "xl/sharedStrings.xml": enc(
      "<sst><si><t>姓名</t></si><si><t>分数</t></si><si><t>张三</t></si></sst>",
    ),
    "xl/worksheets/sheet1.xml": enc(
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>95.5</v></c></row></sheetData></worksheet>',
    ),
    "xl/worksheets/sheet2.xml": enc(
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>满分 100</t></is></c></row></sheetData></worksheet>',
    ),
  });
}

/** 手写一个单页 PDF。cjk=true 时用 STSong-Light + UniGB-UCS2-H(不嵌入字体,靠 CMap 才能取出文字) */
export function pdf(text: string, opts: { cjk?: boolean; empty?: boolean } = {}): Uint8Array {
  const font = opts.cjk
    ? "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>"
    : "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const shown = opts.cjk
    ? `<${[...text].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}>`
    : `(${text})`;
  const stream = opts.empty ? "0 0 m 100 100 l S" : `BT /F1 20 Tf 20 100 Td ${shown} Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    font,
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 7 0 R >>",
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

/**
 * 有空单元格的表:Excel 不写空单元格,只有坐标能说明值在哪一列。
 * 第 2 行缺 B2(语文)、只有 A2 与 C2;第 3 行的单元格没写坐标(按顺序排);第 4 行只有 AB4
 */
export function xlsxWithGaps(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": enc(
      '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    ),
    "xl/workbook.xml": enc(
      '<workbook><sheets><sheet name="成绩" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": enc(
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    "xl/sharedStrings.xml": enc(
      "<sst><si><t>姓名</t></si><si><t>语文</t></si><si><t>数学</t></si><si><t>张三</t></si><si><t>李四</t></si></sst>",
    ),
    "xl/worksheets/sheet1.xml": enc(
      "<worksheet><sheetData>" +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="C2"><v>95</v></c></row>' +
        '<row r="3"><c t="s"><v>4</v></c><c><v>88</v></c><c><v>90</v></c></row>' +
        '<row r="4"><c r="AB4" t="inlineStr"><is><t>备注</t></is></c></row>' +
        "</sheetData></worksheet>",
    ),
  });
}

/** 一个解压后很大(约 85MB XML)、压缩后很小的 Word:解析要做大量同步工作 */
export function heavyDocx(): Uint8Array {
  const p = "<w:p><w:r><w:t>x</w:t></w:r></w:p>";
  return zipSync(
    {
      "[Content_Types].xml": enc(
        '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "word/document.xml": enc(`<w:document><w:body>${p.repeat(2_500_000)}</w:body></w:document>`),
    },
    { level: 1 },
  );
}
