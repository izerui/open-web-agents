// TranscriptPort 的落地实现:读 SDK 写在盘上的 jsonl,还原成域内事件。
//
// 【为什么这里不需要适配层】jsonl 每行的外层形状是 {type, message, uuid, cwd, ...},
// 而 normalizeSdkMessage 读的正是 m.type 与 m.message —— 与流式消息同构。
// 所以这一份归一逻辑同时服务实时流与历史回放:两条路径出来的事件形状必然一致,
// 前端渲染不必分情况处理,SDK 变更也只有一处要改。
//
// 【安全】jsonl 是 SDK 直接写的【未脱敏原文】—— agent 在 Bash 里内联的密钥会原样落盘。
// 必须经 normalizeSdkMessage(内含 redactSecrets)输出,绝不能把文件内容裸传给调用方。

import fs from "node:fs/promises";
import path from "node:path";
import { normalizeSdkMessage } from "@/lib/modules/agent-engine/domain/normalize";
import { redactSecrets } from "@/lib/modules/agent-engine/domain/redact";
import { transcriptPathFor } from "@/lib/modules/agent-engine/domain/transcript-path";
import type { TranscriptPort, TranscriptRange } from "@/lib/modules/agent-engine/ports";
import type { AgentEvent } from "@/lib/shared";

/**
 * 读不到时,查一眼同名 jsonl 是不是躺在【别的】目录下 —— 那说明路径编码规则与 SDK 对不上。
 *
 * 【为什么值得多扫一次盘】这个 bug 真实发生过:编码规则漏了点(`.claude` 该编成 `--claude`),
 * 于是含点的路径整个读不到,而表现是历史一片空白、没有任何报错 —— 极难归因。
 * 规则已修,但 SDK 对空格、中文等是否另有替换尚无实证。留下这层探针,
 * 下一个未知字符至少会在日志里留个痕,而不是又一次静默空白。
 *
 * 只在【已经读不到】的路径上跑,正常情况零开销。扫盘自身失败一律忽略 ——
 * 探针不该反过来影响主流程。
 */
async function warnIfEncodingDrifted(
  dataDir: string,
  expectedFile: string,
  sdkSessionId: string,
): Promise<void> {
  const projects = path.join(path.resolve(dataDir), ".agent-home", ".claude", "projects");
  const fileName = `${sdkSessionId}.jsonl`;
  const expectedDir = path.basename(path.dirname(expectedFile));
  try {
    for (const dir of await fs.readdir(projects)) {
      if (dir === expectedDir) continue;
      try {
        await fs.access(path.join(projects, dir, fileName));
      } catch {
        continue;
      }
      console.warn(
        `[owa] transcript 路径编码可能与 SDK 不一致:期望目录 ${expectedDir},但 ${fileName} 实际在 ${dir} —— 历史回放会静默为空,请核对 domain/transcript-path.ts 的 projectDirNameFor 替换规则`,
      );
      return;
    }
  } catch {
    // projects 目录不存在(还没跑过任何会话)等 —— 探针失败不该影响主流程
  }
}

/**
 * 截出一轮自己的那一段:从 uuid = first 的行到 uuid = last 的行(含两端)。
 *
 * 【为什么要截】续接同一个 SDK 会话的各轮写进同一份 jsonl(resume 不换 session id,
 * 2026-10 用 scripts/sdk-probe 实测)。不截的话,每一轮的历史都是整份文件 —— 第 1 轮
 * 也会显示之后所有轮的过程。
 *
 * 找不到起点返回空:宁可这一轮空着,也不能把别的轮次的过程当成它的。
 * 找不到终点(本轮在写盘途中被杀)读到文件末尾。
 */
function sliceByUuid(lines: unknown[], range: TranscriptRange): unknown[] {
  const uuidOf = (l: unknown) => (l as { uuid?: unknown } | null)?.uuid;
  const start = lines.findIndex((l) => uuidOf(l) === range.first);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i >= start && uuidOf(l) === range.last);
  return lines.slice(start, end < 0 ? undefined : end + 1);
}

/**
 * 运行中途追加的消息在 transcript 里的两种形态(scripts/sdk-probe/steer-*.mjs 实测):
 *   - 插进当前这一轮:`{type:"attachment", attachment:{type:"queued_command", prompt}}`
 *   - 在本轮回答之后再答一轮:一条普通的用户文本消息
 * 后一种只在【按本轮范围截取】时才认 —— 范围从本轮第一条模型消息开始,本轮的提示词行在范围外,
 * 范围里的用户文本只可能是追加的;读整份(旧数据)时各轮的提示词也在里面,认了就会把提示词当成追加。
 */
function steerOf(msg: unknown, opts: { inOwnRange: boolean }): AgentEvent | null {
  const m = msg as {
    type?: string;
    isMeta?: boolean;
    isCompactSummary?: boolean;
    attachment?: { type?: string; prompt?: unknown };
    message?: { content?: unknown };
  } | null;
  if (!m) return null;
  if (m.type === "attachment" && m.attachment?.type === "queued_command") {
    const p = m.attachment.prompt;
    return typeof p === "string" ? steerEvent(p) : null;
  }
  if (!opts.inOwnRange || m.type !== "user" || m.isMeta || m.isCompactSummary) return null;
  const c = m.message?.content;
  if (typeof c === "string") return steerEvent(c);
  // 只有文本块的用户消息才是人说的话;带 tool_result 的是工具输出
  if (
    Array.isArray(c) &&
    c.length > 0 &&
    c.every((b) => (b as { type?: string })?.type === "text")
  ) {
    return steerEvent(c.map((b) => String((b as { text?: unknown }).text ?? "")).join(""));
  }
  return null;
}

function steerEvent(text: string): AgentEvent {
  return { kind: "steer", text: redactSecrets(text), outcome: "delivered" };
}

export class JsonlTranscript implements TranscriptPort {
  async read(args: {
    dataDir: string;
    workspaceDir: string;
    sdkSessionId: string;
    range?: TranscriptRange;
  }): Promise<AgentEvent[]> {
    // SDK 按工作目录的【真实路径】(符号链接已解析)编目录名,这里也先解析;
    // 目录已被清理等读不到真实路径时按原路径算(随后读不到文件,照常返回空)
    const workspaceDir = await fs.realpath(args.workspaceDir).catch(() => args.workspaceDir);
    // 路径推导里的白名单校验要在读盘【之前】把穿越挡掉,所以不放进下面的 try。
    const file = transcriptPathFor({ ...args, workspaceDir });

    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      // 文件不存在/无权读 —— 见端口注释:历史缺失是常态,不是错误。
      // 但"确实没有"与"路径推错了"表现完全一样,故顺手探一下后者(见上方函数注释)。
      await warnIfEncodingDrifted(args.dataDir, file, args.sdkSessionId);
      return [];
    }

    const lines: unknown[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // 半行写入(进程被杀在写盘途中)只该丢这一行。
        // 整份 abort 的话,一次崩溃就让此前所有轮次的历史一起看不见了。
      }
    }

    const out: AgentEvent[] = [];
    // skipStreamed 恒为 false:历史回放没有"增量已推送过"这回事,
    // 完整消息就是唯一来源,跳过就什么都不剩了。
    const slice = args.range ? sliceByUuid(lines, args.range) : lines;
    for (const msg of slice) {
      const steer = steerOf(msg, { inOwnRange: args.range !== undefined });
      if (steer) out.push(steer);
      else out.push(...normalizeSdkMessage(msg));
    }
    return out;
  }
}
