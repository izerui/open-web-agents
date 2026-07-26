// 结构化输出的契约校验。
//
// 这是"助手能被企业系统当接口用"的守门人:调用方按 outputSchema 写死了解析逻辑,
// 平台就必须保证——要么给出符合契约的 JSON,要么明确报失败,绝不给"半对"的结果。

import type { JsonSchema } from "@/lib/shared";
import Ajv, { type ValidateFunction } from "ajv";

export interface ValidationResult {
  ok: boolean;
  /** 人类可读的失败原因,直接进 run 的 errorInfo 供调用方排查。 */
  errors?: string[];
}

// 编译有成本,按 schema 缓存(同一助手每轮都用同一个 schema)
const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new WeakMap<object, ValidateFunction>();

function compile(schema: JsonSchema): ValidateFunction {
  const cached = cache.get(schema);
  if (cached) return cached;
  const fn = ajv.compile(schema);
  cache.set(schema, fn);
  return fn;
}

export function validateStructured(schema: JsonSchema, value: unknown): ValidationResult {
  if (value === undefined) {
    return { ok: false, errors: ["未产出结构化结果"] };
  }

  let validate: ValidateFunction;
  try {
    validate = compile(schema);
  } catch (err) {
    // schema 本身写错了(助手配置问题),要能明确区分于"结果不合格"
    return {
      ok: false,
      errors: [`outputSchema 非法: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (validate(value)) return { ok: true };

  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || "/"} ${e.message ?? "校验失败"}`,
  );
  return { ok: false, errors: errors.length ? errors : ["不符合 outputSchema"] };
}
