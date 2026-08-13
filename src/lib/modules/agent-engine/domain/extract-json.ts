// 从模型的自由文本里提取 JSON 对象。
//
// 为什么需要:SDK 原生 outputFormat 靠约束解码保证结构化输出,但第三方 Anthropic 兼容网关
// (DashScope / GLM 等)对 output_format 的支持并不一致 —— 实测同一智能体有时拿不到
// structured_output。此时若直接判失败,"智能体即接口"在兼容网关上就不可用。
//
// 故留一条【明确的降级路径】:文本里能提取出合规 JSON 就采信,提取不出才判失败。
// 这不放松契约 —— 提取结果仍要过 outputSchema 校验。

/**
 * 从文本里找出第一个完整的顶层 JSON 对象。
 *
 * 用括号配平扫描而非贪婪正则:模型常把 JSON 包在 ```json 代码块里,或前后带解释文字,
 * 正则的 /\{.*\}/s 会把"两个对象之间的文字"也一起吞掉。
 * 扫描时跳过字符串字面量内的括号与转义,避免 {"a":"}"} 这类内容把配平算错。
 */
export function extractJsonObject(text: string): unknown {
  if (!text) return undefined;

  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break; // 这一段不是合法 JSON,从下一个 { 重新试
          }
        }
      }
    }
  }
  return undefined;
}
