// 接入代码片段:纯函数,按智能体的入参契约生成可直接运行的调用示例。
//
// 【为什么单独成文件】构建器底部和接入中心都要用;以前只有构建器里一段 curl,
// 曾经复制即 401(没带 Key、相对地址、入参写死)。生成逻辑集中一处、有单测兜着。

/** 按 JSON Schema 生成一份示例值,让复制下来的请求能直接通过入参校验。 */
export function sampleFromSchema(schema: unknown, depth = 0): unknown {
  const sch = (schema ?? {}) as {
    type?: string | string[];
    properties?: Record<string, unknown>;
    items?: unknown;
    enum?: unknown[];
    example?: unknown;
    examples?: unknown[];
    default?: unknown;
  };
  if (sch.example !== undefined) return sch.example;
  if (Array.isArray(sch.examples) && sch.examples.length > 0) return sch.examples[0];
  if (sch.default !== undefined) return sch.default;
  if (Array.isArray(sch.enum) && sch.enum.length > 0) return sch.enum[0];
  const type = Array.isArray(sch.type) ? sch.type[0] : sch.type;
  if (depth > 4) return null;
  switch (type) {
    case "object":
      return Object.fromEntries(
        Object.entries(sch.properties ?? {}).map(([k, v]) => [k, sampleFromSchema(v, depth + 1)]),
      );
    case "array":
      return [sampleFromSchema(sch.items, depth + 1)];
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    default:
      return "…";
  }
}

export interface SnippetInput {
  origin: string;
  agentId: string;
  inputSchema?: Record<string, unknown> | null;
  hasOutputSchema: boolean;
}

export interface Snippets {
  curl: string;
  python: string;
  node: string;
  /** 嵌入组件:后端换令牌 + 页面放 script */
  embed: string;
}

const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export function buildSnippets({
  origin,
  agentId,
  inputSchema,
  hasOutputSchema,
}: SnippetInput): Snippets {
  const input = inputSchema ? sampleFromSchema(inputSchema) : "你的输入";
  const body = JSON.stringify({ input }, null, 2);
  const invokeUrl = `${origin}/api/agents/${agentId}/invoke`;
  const resultField = hasOutputSchema ? "structured" : "text";

  const curl = `curl -X POST ${invokeUrl} \\
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

# 重试时沿用同一个 Idempotency-Key,不会重复执行与计费
r = requests.post(
    f"{BASE}/api/agents/${agentId}/invoke",
    headers={**HEADERS, "Idempotency-Key": str(uuid.uuid4())},
    json=${pyLiteral({ input })},
    timeout=30,
)
r.raise_for_status()
task_id = r.json()["taskId"]

while True:
    res = requests.get(f"{BASE}/api/agents/{task_id}/result", headers=HEADERS, timeout=30).json()
    if res["done"]:
        break
    time.sleep(2)

if res["status"] != "success":
    raise RuntimeError(res.get("error"))
print(res["${resultField}"])`;

  const node = `const BASE = ${JSON.stringify(origin)};
const headers = { "X-Api-Key": process.env.OWA_API_KEY };

// 重试时沿用同一个 Idempotency-Key,不会重复执行与计费
const r = await fetch(\`\${BASE}/api/agents/${agentId}/invoke\`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify(${JSON.stringify({ input }, null, 2).replaceAll("\n", "\n  ")}),
});
if (!r.ok) throw new Error((await r.json()).code);
const { taskId } = await r.json();

let res;
do {
  await new Promise((ok) => setTimeout(ok, 2000));
  res = await (await fetch(\`\${BASE}/api/agents/\${taskId}/result\`, { headers })).json();
} while (!res.done);

if (res.status !== "success") throw new Error(res.error?.message);
console.log(res.${resultField});`;

  const embed = `// ① 你的后端:用 API Key 换一枚短时效令牌(Key 永远不要下发到浏览器)
const r = await fetch(${JSON.stringify(`${origin}/api/embed/token`)}, {
  method: "POST",
  headers: { "X-Api-Key": process.env.OWA_API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ agentId: ${JSON.stringify(agentId)} }),
});
const { token } = await r.json();

<!-- ② 你的页面:把令牌写进 data-token,右下角会出现对话浮窗 -->
<script src="${origin}/api/embed/script" data-token="<上一步的 token>"></script>`;

  return { curl, python, node, embed };
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
