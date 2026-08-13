// JSON Schema 校验的公共底座。输入契约与输出契约共用同一套编译与缓存。
//
// 【为什么不能用一个全局 Ajv + WeakMap】曾经是这么写的,两个坑叠在一起:
//
// 1. WeakMap 按【对象身份】缓存,而仓储每次 get() 都从 JSON 列解析出一个新对象,
//    缓存永远不命中 —— 每一轮运行都重新编译一次。
// 2. 全局 Ajv 有个 schema 注册表,同一个 `$id` 不允许注册两次。于是带 `$id` 的
//    schema(从 JSON-Schema 工具链粘过来的极常见)第 1 次能编译,第 2 次开始抛
//    "schema with key or id already exists" —— 而这个异常被上层 catch 成
//    "outputSchema 非法",把库的内部状态问题说成用户的配置写错了。
//
// 结果就是:智能体每进程只能正常工作一次,重启前永久损坏,且错误信息指错了方向。
//
// 现在按 schema 的【内容】缓存,并且每个 schema 用独立的 Ajv 实例 ——
// 注册表不再共享,`$id` 冲突从根上不存在。

import type { JsonSchema } from "@/lib/shared";
import Ajv, { type ValidateFunction } from "ajv";

export interface ValidationResult {
  ok: boolean;
  /** 人类可读的失败原因,直接进 run 的 errorInfo 供调用方排查。 */
  errors?: string[];
}

/** 编译结果:成功给校验函数,失败给原因(schema 本身写错了)。 */
type Compiled = { fn: ValidateFunction } | { error: string };

const cache = new Map<string, Compiled>();
/** 上限只是防呆:智能体数量有限,不会真的涨到这个量级。 */
const CACHE_LIMIT = 500;

function compile(schema: JsonSchema): Compiled {
  let key: string;
  try {
    key = JSON.stringify(schema);
  } catch {
    // 循环引用之类 —— 不缓存,直接编译
    key = "";
  }

  if (key) {
    const hit = cache.get(key);
    if (hit) return hit;
  }

  let result: Compiled;
  try {
    // 每个 schema 一个独立实例:注册表不共享,$id 不会撞
    result = { fn: new Ajv({ allErrors: true, strict: false }).compile(schema) };
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }

  if (key) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, result);
  }
  return result;
}

/**
 * 按 JSON Schema 校验一个值。
 *
 * `label` 只用于错误文案(如 "outputSchema" / "inputSchema"),
 * 好让调用方一眼看出是哪一侧的契约没对上。
 */
export function validateAgainstSchema(
  schema: JsonSchema,
  value: unknown,
  label: string,
): ValidationResult {
  const compiled = compile(schema);
  if ("error" in compiled) {
    // schema 本身非法(智能体配置问题),必须与"值不合格"区分开
    return { ok: false, errors: [`${label} 非法: ${compiled.error}`] };
  }

  if (compiled.fn(value)) return { ok: true };

  const errors = (compiled.fn.errors ?? []).map(
    (e) => `${e.instancePath || "/"} ${e.message ?? "不符合约束"}`,
  );
  return { ok: false, errors: errors.length > 0 ? errors : ["不符合 schema"] };
}

/** 仅测试用:清空编译缓存,避免用例之间互相影响。 */
export function _clearSchemaCache(): void {
  cache.clear();
}
