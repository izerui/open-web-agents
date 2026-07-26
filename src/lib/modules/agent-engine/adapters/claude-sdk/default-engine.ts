// 【全工程唯一 import claude-agent-sdk 的地方】
//
// 换掉 SDK 只需重写本文件 + options/normalize 的翻译规则,域层与应用层零改动 —— 这是 ACL 的回报。
// 注意:不要在测试里 import 本文件(会拉起真 SDK);测试用 ClaudeSdkEngine + 注入的 queryFn。

import path from "node:path";
import type { ModelGatewayPort } from "@/lib/modules/model-gateway/ports";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSdkEngine, type QueryFn } from "./runner";

const sdkQuery: QueryFn = ({ prompt, options }) =>
  // SDK 的 options 类型面很宽且随版本变化,此处是 ACL 的边界,窄化交给 buildSdkOptions 保证
  query({ prompt, options: options as Parameters<typeof query>[0]["options"] });

/**
 * 创建绑定真实 SDK 的引擎。
 * @param dataDir 绝对路径的数据根目录;agent 共享 HOME 落在其下的 .agent-home
 *   —— 容器运行用户 HOME 常为不可写的 /nonexistent,工具写 ~/.cache 会 EACCES;
 *      用固定共享目录既可写,又让缓存跨会话复用。
 */
export function createClaudeSdkEngine(dataDir: string, gateway: ModelGatewayPort): ClaudeSdkEngine {
  return new ClaudeSdkEngine(sdkQuery, {
    sharedHome: path.join(dataDir, ".agent-home"),
    gateway,
  });
}
