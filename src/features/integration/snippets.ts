// 接入代码片段:纯函数,按智能体的入参契约生成可直接运行的调用示例。
//
// 【为什么单独成文件】构建器底部和接入中心都要用;以前只有构建器里一段 curl,
// 曾经复制即 401(没带 Key、相对地址、入参写死)。生成逻辑集中一处、有单测兜着。
//
// 示例代码的两条底线:
// 1. 轮询必须检查 HTTP 状态,并且整体期限要覆盖【网络等待本身】 ——
//    Key 被吊销后 /result 回 401,响应里没有 done,不检查就会无限请求;
//    只在拿到响应后才比较 deadline 也不够:服务端不回响应、或发了响应头不结束 body,
//    就永远走不到那次比较。
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
  /** 轮询整体期限(秒),默认 POLL_DEADLINE_SECONDS;测试里调小 */
  pollDeadlineSeconds?: number;
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
  pollDeadlineSeconds = POLL_DEADLINE_SECONDS,
}: SnippetInput): Snippets {
  const N = pollDeadlineSeconds;
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

  const python = `import json, os, queue, threading, time, uuid, requests

BASE = ${JSON.stringify(origin)}
HEADERS = {"X-Api-Key": os.environ["OWA_API_KEY"]}
${todo ? `\n# ${todo}` : ""}
# 重试时沿用同一个 Idempotency-Key,不会重复执行与计费。提交单独限时 30 秒
r = requests.post(
    f"{BASE}/api/agents/${agentId}/invoke",
    headers={**HEADERS, "Idempotency-Key": str(uuid.uuid4())},
    json=${pyLiteral({ input })},
    timeout=30,
)
if r.status_code not in (200, 202):
    raise RuntimeError(f"提交失败 HTTP {r.status_code}: {r.text}")
task_id = r.json()["taskId"]

# 轮询整体期限 ${N} 秒:连接、DNS 解析、等响应头、读响应体、间隔等待都算在内。
# requests 的 timeout 只管单次连接/两次读之间的间隔,不是总时长(也不管 DNS):
# 服务端声明了 Content-Length 再慢慢发数据,就能一直拖住它。
# 所以每次请求放到守护线程里跑,主线程最多等到期限 —— 到期直接放弃这次请求并抛 TimeoutError。
# 注意:被放弃的请求仍在后台线程里,直到它自己的 timeout 或服务端结束;
# 守护线程不会阻止进程退出,但若你捕获 TimeoutError 后长期继续运行,它会占着一个连接。
# 长任务建议改用 Webhook 回调,而不是把期限调得很大。
deadline = time.monotonic() + ${N}

def timed_out():
    return TimeoutError(f"等待结果超时(${N} 秒),taskId={task_id}")

def get_result():
    left = deadline - time.monotonic()
    if left <= 0:
        raise timed_out()
    box = queue.Queue(maxsize=1)

    def run():
        try:
            r = requests.get(
                f"{BASE}/api/agents/{task_id}/result", headers=HEADERS, timeout=min(30, left)
            )
            box.put((True, (r.status_code, r.content)))
        except BaseException as e:
            box.put((False, e))

    threading.Thread(target=run, daemon=True).start()
    try:
        ok, value = box.get(timeout=left)
    except queue.Empty:
        raise timed_out() from None
    if not ok:
        if time.monotonic() >= deadline:
            raise timed_out() from value
        raise value
    status, body = value
    if status != 200:
        raise RuntimeError(f"查询结果失败 HTTP {status}: {body.decode(errors='replace')}")
    return json.loads(body)

while True:
    res = get_result()
    if res.get("done"):
        break
    time.sleep(max(0, min(2, deadline - time.monotonic())))

if res["status"] != "success":
    raise RuntimeError(res.get("error"))
print(res["${resultField}"])`;

  const node = `const BASE = ${JSON.stringify(origin)};
const headers = { "X-Api-Key": process.env.OWA_API_KEY };
${todo ? `\n// ${todo}` : ""}
// 重试时沿用同一个 Idempotency-Key,不会重复执行与计费。提交单独限时 30 秒
const r = await fetch(\`\${BASE}/api/agents/${agentId}/invoke\`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify(${JSON.stringify({ input }, null, 2).replaceAll("\n", "\n  ")}),
  signal: AbortSignal.timeout(30_000),
});
if (!r.ok) throw new Error(\`提交失败 HTTP \${r.status}: \${await r.text()}\`);
const { taskId } = await r.json();

// 轮询整体期限 ${N} 秒:同一个取消信号覆盖每次请求的等待、响应体读取与间隔等待,
// 服务端不回响应、只发响应头不结束 body、或一直慢速发送,都会在期限到时被取消。
// 长任务建议改用 Webhook 回调,而不是把期限调得很大。
const signal = AbortSignal.timeout(${N * 1000});
let res;
try {
  for (;;) {
    const q = await fetch(\`\${BASE}/api/agents/\${taskId}/result\`, { headers, signal });
    if (!q.ok) throw new Error(\`查询结果失败 HTTP \${q.status}: \${await q.text()}\`);
    res = await q.json();
    if (res.done) break;
    await new Promise((ok, fail) => {
      const t = setTimeout(ok, 2000);
      signal.addEventListener("abort", () => (clearTimeout(t), fail(signal.reason)), { once: true });
    });
  }
} catch (err) {
  if (signal.aborted) throw new Error(\`等待结果超时(${N} 秒),taskId=\${taskId}\`, { cause: err });
  throw err;
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
