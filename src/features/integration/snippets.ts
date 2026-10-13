// 接入代码片段:纯函数,按智能体的入参契约生成可直接运行的调用示例。
//
// 【为什么单独成文件】构建器底部和接入中心都要用;以前只有构建器里一段 curl,
// 曾经复制即 401(没带 Key、相对地址、入参写死)。生成逻辑集中一处、有单测兜着。
//
// 示例代码的两条底线:
// 1. 轮询必须检查 HTTP 状态并有整体期限 —— Key 被吊销后 /result 回 401,
//    响应里没有 done,不检查就会无限请求。
// 2. 示例入参必须过平台同款的 inputSchema 校验;过不了就明说"需要按实际填写",
//    不能继续承诺"复制即可运行"。

import { validateInput } from "@/lib/modules/agent/domain/validate-output";

type Schema = {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  enum?: unknown[];
  const?: unknown;
  example?: unknown;
  examples?: unknown[];
  default?: unknown;
  oneOf?: unknown[];
  anyOf?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  format?: string;
};

const FORMAT_SAMPLES: Record<string, string> = {
  email: "user@example.com",
  uri: "https://example.com",
  url: "https://example.com",
  "date-time": "2026-01-01T00:00:00Z",
  date: "2026-01-01",
  time: "00:00:00Z",
  uuid: "00000000-0000-4000-8000-000000000000",
};

/** 在 minimum / maximum / exclusive* / multipleOf 约束内挑一个数(尽力而为,最终以校验为准)。 */
function sampleNumber(sch: Schema, integer: boolean): number {
  let v = 0;
  if (sch.minimum !== undefined) v = sch.minimum;
  else if (sch.exclusiveMinimum !== undefined) {
    v = integer ? Math.floor(sch.exclusiveMinimum) + 1 : sch.exclusiveMinimum + 1;
  } else if (sch.maximum !== undefined && sch.maximum < 0) v = sch.maximum;
  else if (sch.exclusiveMaximum !== undefined && sch.exclusiveMaximum <= 0) {
    v = sch.exclusiveMaximum - 1;
  }
  if (integer) v = Math.ceil(v);
  if (sch.multipleOf) v = Math.ceil(v / sch.multipleOf) * sch.multipleOf;
  return v;
}

/**
 * 按 JSON Schema 生成一份示例值。
 *
 * 这是"尽力而为":常见约束(必填、取值范围、长度、数组最少个数、format)会照顾到,
 * 但 pattern、if/then 这类生成不出来。所以生成结果【一定要再用 validateInput 校验】,
 * 别把它当成"保证合法"。
 */
export function sampleFromSchema(schema: unknown, depth = 0): unknown {
  const sch = (schema ?? {}) as Schema;
  if (sch.const !== undefined) return sch.const;
  if (sch.example !== undefined) return sch.example;
  if (Array.isArray(sch.examples) && sch.examples.length > 0) return sch.examples[0];
  if (sch.default !== undefined) return sch.default;
  if (Array.isArray(sch.enum) && sch.enum.length > 0) return sch.enum[0];
  const alt = sch.oneOf?.[0] ?? sch.anyOf?.[0];
  if (alt !== undefined) return sampleFromSchema(alt, depth + 1);
  const type = Array.isArray(sch.type) ? sch.type[0] : sch.type;
  if (depth > 6) return null;
  switch (type) {
    case "object":
      return Object.fromEntries(
        Object.entries(sch.properties ?? {}).map(([k, v]) => [k, sampleFromSchema(v, depth + 1)]),
      );
    case "array":
      return Array.from({ length: Math.max(1, sch.minItems ?? 1) }, () =>
        sampleFromSchema(sch.items, depth + 1),
      );
    case "integer":
      return sampleNumber(sch, true);
    case "number":
      return sampleNumber(sch, false);
    case "boolean":
      return false;
    case "null":
      return null;
    default: {
      const s = (sch.format && FORMAT_SAMPLES[sch.format]) || "…";
      return sch.minLength && s.length < sch.minLength ? s.padEnd(sch.minLength, "…") : s;
    }
  }
}

export interface SampleInput {
  value: unknown;
  /** 示例是否通过了该智能体的 inputSchema 校验 */
  valid: boolean;
  /** 不合法时的原因(来自 validateInput),给界面提示用 */
  issues: string[];
}

/** 生成示例入参并用平台同款校验器复核 —— 只有复核通过才能说"复制即可通过入参校验"。 */
export function sampleInput(inputSchema?: Record<string, unknown> | null): SampleInput {
  if (!inputSchema) return { value: "你的输入", valid: true, issues: [] };
  const value = sampleFromSchema(inputSchema);
  const r = validateInput(inputSchema, value);
  return { value, valid: r.ok, issues: r.ok ? [] : (r.errors ?? ["未知原因"]) };
}

export interface SnippetInput {
  origin: string;
  agentId: string;
  inputSchema?: Record<string, unknown> | null;
  hasOutputSchema: boolean;
}

/** 轮询整体期限(秒)。长任务请改用 Webhook 回调,而不是把期限调得很大。 */
export const POLL_DEADLINE_SECONDS = 600;

export interface Snippets {
  /** 示例入参及其校验结果 */
  sample: SampleInput;
  curl: string;
  python: string;
  node: string;
  /** 嵌入组件:后端换令牌 + 页面放 script */
  embed: string;
}

export type SnippetLang = Exclude<keyof Snippets, "sample">;

const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export function buildSnippets({
  origin,
  agentId,
  inputSchema,
  hasOutputSchema,
}: SnippetInput): Snippets {
  const sample = sampleInput(inputSchema);
  const input = sample.value;
  const body = JSON.stringify({ input }, null, 2);
  const invokeUrl = `${origin}/api/agents/${agentId}/invoke`;
  const resultField = hasOutputSchema ? "structured" : "text";
  // 示例过不了入参校验时,在代码里也写明 —— 代码常被单独复制走,只靠界面提示不够
  const todo = sample.valid ? "" : "需要按实际填写:示例入参未通过该智能体的 inputSchema 校验";

  const curl = `${todo ? `# ${todo}\n` : ""}curl -X POST ${invokeUrl} \\
  -H "X-Api-Key: $OWA_API_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d ${shellQuote(body)}
# → 202 { "taskId": "…" }

curl ${origin}/api/agents/<taskId>/result -H "X-Api-Key: $OWA_API_KEY"
# → { "status": "success", "done": true, "${resultField}": … }`;

  const python = `import os, time, uuid, requests

BASE = ${JSON.stringify(origin)}
HEADERS = {"X-Api-Key": os.environ["OWA_API_KEY"]}
${todo ? `\n# ${todo}` : ""}
# 重试时沿用同一个 Idempotency-Key,不会重复执行与计费
r = requests.post(
    f"{BASE}/api/agents/${agentId}/invoke",
    headers={**HEADERS, "Idempotency-Key": str(uuid.uuid4())},
    json=${pyLiteral({ input })},
    timeout=30,
)
if r.status_code not in (200, 202):
    raise RuntimeError(f"提交失败 HTTP {r.status_code}: {r.text}")
task_id = r.json()["taskId"]

# 整体期限:Key 被吊销、任务卡住时都要能结束;长任务建议改用 Webhook 回调
deadline = time.monotonic() + ${POLL_DEADLINE_SECONDS}
while True:
    r = requests.get(f"{BASE}/api/agents/{task_id}/result", headers=HEADERS, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"查询结果失败 HTTP {r.status_code}: {r.text}")
    res = r.json()
    if res.get("done"):
        break
    if time.monotonic() > deadline:
        raise TimeoutError(f"等待结果超时,taskId={task_id}")
    time.sleep(2)

if res["status"] != "success":
    raise RuntimeError(res.get("error"))
print(res["${resultField}"])`;

  const node = `const BASE = ${JSON.stringify(origin)};
const headers = { "X-Api-Key": process.env.OWA_API_KEY };
${todo ? `\n// ${todo}` : ""}
// 重试时沿用同一个 Idempotency-Key,不会重复执行与计费
const r = await fetch(\`\${BASE}/api/agents/${agentId}/invoke\`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify(${JSON.stringify({ input }, null, 2).replaceAll("\n", "\n  ")}),
});
if (!r.ok) throw new Error(\`提交失败 HTTP \${r.status}: \${await r.text()}\`);
const { taskId } = await r.json();

// 整体期限:Key 被吊销、任务卡住时都要能结束;长任务建议改用 Webhook 回调
const deadline = Date.now() + ${POLL_DEADLINE_SECONDS}_000;
let res;
for (;;) {
  const q = await fetch(\`\${BASE}/api/agents/\${taskId}/result\`, { headers });
  if (!q.ok) throw new Error(\`查询结果失败 HTTP \${q.status}: \${await q.text()}\`);
  res = await q.json();
  if (res.done) break;
  if (Date.now() > deadline) throw new Error(\`等待结果超时,taskId=\${taskId}\`);
  await new Promise((ok) => setTimeout(ok, 2000));
}

if (res.status !== "success") throw new Error(res.error?.message);
console.log(res.${resultField});`;

  const embed = `// ① 你的后端:用 API Key 换一枚短时效令牌(Key 永远不要下发到浏览器)
const r = await fetch(${JSON.stringify(`${origin}/api/embed/token`)}, {
  method: "POST",
  headers: { "X-Api-Key": process.env.OWA_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ agentId: ${JSON.stringify(agentId)} }),
});
if (!r.ok) throw new Error(\`换取令牌失败 HTTP \${r.status}: \${await r.text()}\`);
const { token } = await r.json();

<!-- ② 你的页面:把令牌写进 data-token,右下角会出现对话浮窗 -->
<script src="${origin}/api/embed/script" data-token="<上一步的 token>"></script>`;

  return { sample, curl, python, node, embed };
}

/** JSON → Python 字面量(true/false/null 需要换写法)。 */
function pyLiteral(v: unknown, indent = 4): string {
  const pad = " ".repeat(indent);
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string" || typeof v === "number") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `[${v.map((x) => pyLiteral(x, indent + 4)).join(", ")}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return `{\n${entries
    .map(([k, x]) => `${pad}    ${JSON.stringify(k)}: ${pyLiteral(x, indent + 4)}`)
    .join(",\n")},\n${pad}}`;
}
