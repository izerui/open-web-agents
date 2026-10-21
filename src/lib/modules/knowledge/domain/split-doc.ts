// 上传的长文件切成多篇:单篇有字数上限(见 limits.ts),超过就按顺序切成「文件名(1/3)」这样的几篇。
// 尽量在空行(页、段之间)切,其次在换行处,实在没有才硬切。字数按字符(码点)算,与上限判定一致。纯逻辑。

export interface DocPart {
  title: string;
  content: string;
}

/** 在后 20% 的范围里找切点:先空行,再换行;都没有就在上限处硬切 */
function cutAt(chars: string[], max: number): number {
  const window = Math.max(1, Math.floor(max * 0.2));
  const from = max - window;
  const joined = (i: number, j: number) => chars.slice(i, j).join("");
  for (const sep of ["\n\n", "\n"]) {
    for (let i = max; i > from; i--) {
      if (joined(i - sep.length, i) === sep) return i;
    }
  }
  return max;
}

export function splitDoc(title: string, content: string, maxChars: number): DocPart[] {
  const chars = [...content];
  if (chars.length <= maxChars) return [{ title, content }];
  const pieces: string[] = [];
  let rest = chars;
  while (rest.length > maxChars) {
    const at = cutAt(rest, maxChars);
    const piece = rest.slice(0, at).join("").trim();
    if (piece) pieces.push(piece);
    rest = rest.slice(at);
  }
  const tail = rest.join("").trim();
  if (tail) pieces.push(tail);
  return pieces.map((p, i) => ({ title: `${title}(${i + 1}/${pieces.length})`, content: p }));
}

/** 文件名 → 文档标题:去掉扩展名与路径,限 255 字(含后缀留出余量) */
export function titleOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const name = base.replace(/\.[^.]+$/, "").trim() || base.trim() || "未命名文件";
  return [...name].slice(0, 240).join("");
}
