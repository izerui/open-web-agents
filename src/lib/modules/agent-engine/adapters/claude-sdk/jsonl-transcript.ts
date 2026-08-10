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
import { transcriptPathFor } from "@/lib/modules/agent-engine/domain/transcript-path";
import type { TranscriptPort } from "@/lib/modules/agent-engine/ports";
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
        `[owa] transcript 路径编码可能与 SDK 不一致:期望目录 ${expectedDir},` +
          `但 ${fileName} 实际在 ${dir} —— 历史回放会静默为空,` +
          "请核对 domain/transcript-path.ts 的 projectDirNameFor 替换规则",
      );
      return;
    }
  } catch {
    // projects 目录不存在(还没跑过任何会话)等 —— 探针失败不该影响主流程
  }
}

export class JsonlTranscript implements TranscriptPort {
  async read(args: {
    dataDir: string;
    workspaceDir: string;
    sdkSessionId: string;
  }): Promise<AgentEvent[]> {
    // 路径推导里的白名单校验要在读盘【之前】把穿越挡掉,所以不放进下面的 try。
    const file = transcriptPathFor(args);

    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      // 文件不存在/无权读 —— 见端口注释:历史缺失是常态,不是错误。
      // 但"确实没有"与"路径推错了"表现完全一样,故顺手探一下后者(见上方函数注释)。
      await warnIfEncodingDrifted(args.dataDir, file, args.sdkSessionId);
      return [];
    }

    const out: AgentEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        // 半行写入(进程被杀在写盘途中)只该丢这一行。
        // 整份 abort 的话,一次崩溃就让此前所有轮次的历史一起看不见了。
        continue;
      }
      // skipStreamed 恒为 false:历史回放没有"增量已推送过"这回事,
      // 完整消息就是唯一来源,跳过就什么都不剩了。
      out.push(...normalizeSdkMessage(msg));
    }
    return out;
  }
}
