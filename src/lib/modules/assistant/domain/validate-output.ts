// 结构化输出的契约校验。
//
// 这是"助手能被企业系统当接口用"的守门人:调用方按 outputSchema 写死了解析逻辑,
// 平台就必须保证——要么给出符合契约的 JSON,要么明确报失败,绝不给"半对"的结果。
//
// 编译与缓存下沉到 validate-schema:输入契约与输出契约是同一件事的两侧,
// 没道理各写一套(而原来那套里藏着 $id 冲突与缓存永不命中两个坑)。

import type { JsonSchema } from "@/lib/shared";
import { type ValidationResult, validateAgainstSchema } from "./validate-schema";

export type { ValidationResult };

export function validateStructured(schema: JsonSchema, value: unknown): ValidationResult {
  if (value === undefined) {
    return { ok: false, errors: ["未产出结构化结果"] };
  }
  return validateAgainstSchema(schema, value, "outputSchema");
}

/**
 * 入站契约校验:助手声明了 inputSchema,调用方就必须按它传。
 *
 * 【为什么对外接口必须校验入参】这个平台的定位是"被 Java/Go/Python 系统当接口调"。
 * 不校验的话,一个字段拼错的请求会被原样塞进提示词,agent 照跑不误,
 * 最后产出一个看起来正常、实际答非所问的结果 —— 调用方拿到 200 和一份结构化 JSON,
 * 根本意识不到自己传错了。早失败、错在哪说清楚,比事后对着结果猜便宜得多。
 */
export function validateInput(schema: JsonSchema, value: unknown): ValidationResult {
  return validateAgainstSchema(schema, value, "inputSchema");
}
