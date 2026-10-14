// 按智能体生成 OpenAPI 3.1 文档。纯逻辑,零 IO。
//
// 【为什么按智能体生成】每个接口型智能体的入参与结果契约不同(inputSchema / outputSchema)。
// 一份通用文档只能写 "input: any / structured: any",集成方还是得来问"到底传什么、回什么"。
// 按智能体把契约嵌进去,可以直接导入 Postman / 生成客户端代码。

import type { JsonSchema } from "@/lib/shared";

export interface OpenApiAgent {
  id: string;
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  /** 文档对应的已发布版本;null = 草稿(从未发布) */
  version?: number | null;
}

const ERROR = {
  type: "object",
  required: ["error", "code"],
  properties: {
    error: { type: "string", description: "人读的说明,措辞可能调整" },
    code: {
      type: "string",
      description: "机读的稳定错误码",
      enum: [
        "unauthorized",
        "forbidden",
        "not_found",
        "invalid_request",
        "input_invalid",
        "prompt_too_large",
        "quota_exceeded",
        "rate_limited",
        "idempotency_key_invalid",
        "idempotency_conflict",
        "service_unavailable",
      ],
    },
  },
};

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

export function buildAgentOpenApi(agent: OpenApiAgent, origin: string): Record<string, unknown> {
  const input: Record<string, unknown> = agent.inputSchema
    ? { ...agent.inputSchema, description: "须符合该智能体声明的 inputSchema" }
    : { type: "string", description: "自然语言输入" };
  const structured: Record<string, unknown> = agent.outputSchema
    ? {
        ...agent.outputSchema,
        description: "符合该智能体声明的 outputSchema;仅 status=success 时存在",
      }
    : { type: "null", description: "该智能体未声明 outputSchema,结果见 text" };

  return {
    openapi: "3.1.0",
    info: {
      title: `${agent.name} —— Open Web Agents`,
      description: agent.description ?? "",
      // 智能体发布一版,文档版本跟着变;未发布的草稿标成 draft
      version: agent.version ? `v${agent.version}` : "draft",
    },
    servers: [{ url: origin }],
    security: [{ ApiKey: [] }],
    paths: {
      [`/api/agents/${agent.id}/invoke`]: {
        post: {
          operationId: "invoke",
          summary: "发起一次运行(异步),返回 taskId",
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              description: "重试同一个请求时带同一个键,拿回第一次受理的任务,不会重复执行与计费",
              schema: { type: "string", maxLength: 128 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["input"],
                  properties: {
                    input,
                    version: {
                      type: "integer",
                      minimum: 1,
                      description: agent.version
                        ? `锁定智能体版本;不传 = 当前发布的版本(本文档对应 v${agent.version})`
                        : "锁定智能体版本;该智能体尚未发布,不传则使用草稿",
                    },
                    override: {
                      type: "object",
                      description: "请求级模型凭证;自定义 baseUrl 必须同时给 key",
                      properties: {
                        baseUrl: { type: "string", format: "uri" },
                        key: { type: "string" },
                        model: { type: "string", enum: ["fable", "opus", "sonnet", "haiku"] },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "202": {
              description: "已受理。X-RateLimit-* 头给出这把 Key 本分钟的剩余次数",
              headers: {
                "X-RateLimit-Limit": { schema: { type: "integer" } },
                "X-RateLimit-Remaining": { schema: { type: "integer" } },
                "X-RateLimit-Reset": {
                  schema: { type: "integer" },
                  description: "距本窗口重置的秒数",
                },
              },
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      taskId: { type: "string" },
                      sessionId: { type: "string" },
                      structured: { type: "boolean", description: "结果是否带结构化输出" },
                      agentVersion: {
                        type: ["integer", "null"],
                        description: "实际执行的版本;null = 草稿",
                      },
                    },
                  },
                },
              },
            },
            "200": { description: "同一 Idempotency-Key 的重放,返回第一次受理的任务" },
            "400": errorResponse("入参不合法"),
            "401": errorResponse("缺少或无效的 API Key"),
            "404": errorResponse("智能体或指定的版本不存在"),
            "402": errorResponse("超出月度额度"),
            "413": errorResponse("输入过长"),
            "422": errorResponse("同一 Idempotency-Key 用于了不同的请求体"),
            "429": {
              description:
                "新调用超出每分钟上限(scope=key:这把 Key;scope=agent:该智能体所有调用方合计)。" +
                "按 Retry-After 等待后重试;同一个 Idempotency-Key 的重放不计入",
              headers: {
                "Retry-After": { schema: { type: "integer" }, description: "需要等待的秒数" },
              },
              content: {
                "application/json": {
                  schema: {
                    allOf: [
                      { $ref: "#/components/schemas/Error" },
                      {
                        type: "object",
                        properties: {
                          scope: { type: "string", enum: ["key", "agent"] },
                          limit: { type: "integer" },
                          retryAfterSeconds: { type: "integer" },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      "/api/agents/{taskId}/result": {
        get: {
          operationId: "getResult",
          summary: "查询结果(轮询直到 done=true)。字段与 webhook 回调、阻塞模式的响应相同",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "当前状态与结果",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      taskId: { type: "string" },
                      status: {
                        type: "string",
                        enum: ["pending", "running", "success", "failed", "cancelled"],
                      },
                      done: { type: "boolean" },
                      agentVersion: {
                        type: ["integer", "null"],
                        description: "实际执行的版本;null = 草稿",
                      },
                      structured,
                      salvaged: {
                        type: "boolean",
                        description:
                          "structured 是从最终文本里提取的,而非模型原生的结构化输出(兼容网关的降级路径)",
                      },
                      text: { type: ["string", "null"], description: "最终回答文本" },
                      summary: {
                        type: ["string", "null"],
                        description: "已废弃:同 text",
                        deprecated: true,
                      },
                      cost: {
                        type: ["object", "null"],
                        properties: {
                          usd: { type: "number" },
                          input: { type: "integer" },
                          output: { type: "integer" },
                          partial: {
                            type: "boolean",
                            description:
                              "运行被中止、没等到结算时为 true:token 为已收到部分,usd 可能缺失",
                          },
                        },
                      },
                      error: {
                        type: ["object", "null"],
                        properties: { kind: { type: "string" }, message: { type: "string" } },
                      },
                      startedAt: { type: ["string", "null"], format: "date-time" },
                      endedAt: { type: ["string", "null"], format: "date-time" },
                    },
                  },
                },
              },
            },
            "404": errorResponse("任务不存在或无权查看"),
          },
        },
      },
      "/api/runs": {
        get: {
          operationId: "listRuns",
          summary: "列出这把 Key 发起的运行",
          parameters: [
            { name: "agentId", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", description: "逗号分隔", schema: { type: "string" } },
            {
              name: "since",
              in: "query",
              description: "ISO 时间或毫秒",
              schema: { type: "string" },
            },
            { name: "until", in: "query", schema: { type: "string" } },
            { name: "cursor", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } },
          ],
          responses: { "200": { description: "{ items, nextCursor }" } },
        },
      },
      "/api/runs/{taskId}/cancel": {
        post: {
          operationId: "cancelRun",
          summary: "取消一个未结束的运行",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "{ cancelled: boolean }" },
            "404": errorResponse("任务不存在或无权操作"),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
      },
      schemas: { Error: ERROR },
    },
  };
}
