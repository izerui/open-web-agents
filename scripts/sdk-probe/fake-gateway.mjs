// 假的 Anthropic Messages API —— 让 SDK 按【我们指定的剧本】调用工具。
//
// 【为什么需要它】要验的是"围栏拦不拦得住",而不是"模型想不想调工具"。
// 用真模型验有三个毛病:要花钱、要联网、还得指望模型配合 ——
// 之前演示拒绝路径时就栽过:模型自己拒绝执行 rm -rf,Bash 压根没被调用,
// 差点把"模型不配合"当成"围栏生效"。
//
// 这里只把【模型】换成假的。SDK 子进程、hook 的 control_request 通道、
// 权限评估顺序、工具执行路径,全是真的。

import http from "node:http";

/** SSE 一帧。 */
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 回一轮"我要调这个工具"。 */
function streamToolUse(res, { id, name, input }) {
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      model: "fake-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  sse(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id, name, input: {} },
  });
  sse(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
  });
  sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

/** 回一轮纯文本并收尾。 */
function streamText(res, text) {
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: "msg_final",
      type: "message",
      role: "assistant",
      model: "fake-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  sse(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  sse(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
  sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

/**
 * 起一个假网关。
 *
 * @param script 剧本:第 n 次 /v1/messages 请求该回什么。
 *   `{ tool: {id,name,input} }` = 回一次工具调用;`{ text }` = 回文本收尾。
 *   剧本用完后一律回文本收尾,免得 SDK 空转。
 */
export async function startFakeGateway(script) {
  let turn = 0;
  /** 每一轮请求里 SDK 送来的 messages —— 工具结果长什么样要靠它看。 */
  const seenRequests = [];

  const server = http.createServer((req, res) => {
    // 连通性探测
    if (req.method === "HEAD") {
      res.writeHead(200).end();
      return;
    }
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      if (!req.url?.includes("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      try {
        seenRequests.push(JSON.parse(body));
      } catch {
        seenRequests.push(null);
      }
      const step = script[turn++];
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (step?.tool) streamToolUse(res, step.tool);
      else streamText(res, step?.text ?? "结束。");
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seenRequests,
    turns: () => turn,
    close: () => server.close(),
  };
}

/**
 * 子进程环境:必须隔离掉本机凭证。
 *
 * 【实测踩过】只设 ANTHROPIC_BASE_URL 没用 —— 本机 Claude Code 处于登录态时,
 * SDK 会拿 OAuth 凭证去打官方端点,表现为 401 重试,而假网关一条连接都收不到。
 * ANTHROPIC_AUTH_TOKEN 置空 + CLAUDE_CONFIG_DIR 换到空目录,才真正指过来。
 * (这也正是生产代码 aliasEnv 里那行 ANTHROPIC_AUTH_TOKEN:"" 的理由。)
 */
export function isolatedEnv(baseUrl, configDir) {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: "fake-key-for-probe",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
}
