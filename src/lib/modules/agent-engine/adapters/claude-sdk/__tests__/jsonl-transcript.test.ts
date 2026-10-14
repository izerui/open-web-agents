// 真实文件系统测试:在临时目录里按 SDK 的落盘规则造 transcript,验证能还原成域内事件。
//
// 夹具的每一行都照抄真实 jsonl 的形状(外层 type/message/uuid/cwd,内层才是 SDK 消息体)——
// 这正是本 adapter 成立的前提:normalizeSdkMessage 读的就是这个形状,不需要适配层。
// 形状一旦被 SDK 改掉,这里会先红。

import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonlTranscript } from "@/lib/modules/agent-engine/adapters/claude-sdk/jsonl-transcript";
import { projectDirNameFor } from "@/lib/modules/agent-engine/domain/transcript-path";
import type { AgentEvent } from "@/lib/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let dataDir: string;
let workspaceDir: string;
const SID = "1f4c20d8-ce64-42cf-a12b-d5a866be1f81";
const transcript = new JsonlTranscript();

/** transcript 该落的目录。刻意复用生产的编码函数 —— 夹具自己再写一遍规则的话,
 * 两边一起错就测不出编码 bug(而编码错的表现恰恰是"读到空",测试反而会绿)。 */
function projectDir(): string {
  // SDK 按工作目录的真实路径编目录名(符号链接已解析 —— macOS 的临时目录就在 /var → /private/var 下)
  return path.join(
    dataDir,
    ".agent-home",
    ".claude",
    "projects",
    projectDirNameFor(fsSync.realpathSync(workspaceDir)),
  );
}

/** 按 SDK 规则写一份 transcript 到该落的位置。 */
async function writeTranscript(sessionId: string, lines: unknown[]): Promise<void> {
  const dir = projectDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "owa-transcript-"));
  workspaceDir = path.join(dataDir, "workspaces", "sess1");
  await fs.mkdir(workspaceDir, { recursive: true });

  await writeTranscript(SID, [
    // SDK 会写一些与对话无关的行,归一层应当安静地跳过而不是崩
    { type: "queue-operation", operation: "enqueue", sessionId: SID },
    {
      type: "assistant",
      uuid: "u1",
      cwd: workspaceDir,
      sessionId: SID,
      message: { id: "m1", content: [{ type: "thinking", thinking: "先看看目录" }] },
    },
    {
      type: "assistant",
      uuid: "u2",
      cwd: workspaceDir,
      sessionId: SID,
      message: {
        id: "m2",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    },
    {
      type: "user",
      uuid: "u3",
      cwd: workspaceDir,
      sessionId: SID,
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
    },
    {
      type: "assistant",
      uuid: "u4",
      cwd: workspaceDir,
      sessionId: SID,
      message: { id: "m3", content: [{ type: "text", text: "目录里有 a.txt" }] },
    },
  ]);
});

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("JsonlTranscript.read", () => {
  it("把 transcript 还原成有序的域内事件", async () => {
    const events = await transcript.read({ dataDir, workspaceDir, sdkSessionId: SID });
    expect(events.map((e) => e.kind)).toEqual(["thinking", "tool_use", "tool_result", "text"]);
  });

  it("保留工具调用与结果的配对关系", async () => {
    const events = await transcript.read({ dataDir, workspaceDir, sdkSessionId: SID });
    const use = events.find((e) => e.kind === "tool_use");
    const result = events.find((e) => e.kind === "tool_result");
    expect(use).toMatchObject({ tool: "Bash", toolUseId: "t1" });
    expect(result).toMatchObject({ toolUseId: "t1", text: "a.txt" });
  });

  it("经符号链接给出的工作目录:按真实路径找到文件(与 SDK 一致)", async () => {
    const link = path.join(dataDir, "ws-link");
    await fs.symlink(workspaceDir, link);
    try {
      const events = await transcript.read({ dataDir, workspaceDir: link, sdkSessionId: SID });
      expect(events.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(link, { force: true });
    }
  });

  it("跳过非对话行而不是抛错", async () => {
    // 夹具里的 queue-operation 行没有 message —— 不该产出事件,也不该让整份读取失败
    const events = await transcript.read({ dataDir, workspaceDir, sdkSessionId: SID });
    expect(events.length).toBe(4);
  });

  it("文件不存在时返回空数组 —— 历史缺失不是错误", async () => {
    // 工作空间被清理、或跨机部署读不到别的机器写的 transcript,都会走到这里。
    // 抛错的话整个历史接口就 500 了,而其余轮次本来是能正常回放的。
    const events = await transcript.read({
      dataDir,
      workspaceDir,
      sdkSessionId: "00000000-0000-0000-0000-000000000000",
    });
    expect(events).toEqual([]);
  });

  it("对密钥脱敏 —— jsonl 是 SDK 直接写的未脱敏原文", async () => {
    const sid = "2f4c20d8-ce64-42cf-a12b-d5a866be1f82";
    await writeTranscript(sid, [
      {
        type: "assistant",
        uuid: "s1",
        cwd: workspaceDir,
        sessionId: sid,
        message: {
          id: "ms",
          content: [
            {
              type: "tool_use",
              id: "ts",
              name: "Bash",
              input: { command: "FOO_TOKEN=sk-abc123def456 echo hi" },
            },
          ],
        },
      },
    ]);
    const events = await transcript.read({ dataDir, workspaceDir, sdkSessionId: sid });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("sk-abc123def456");
    expect(serialized).toContain("***");
  });

  it("挡住经 sdkSessionId 的路径穿越", async () => {
    await expect(
      transcript.read({ dataDir, workspaceDir, sdkSessionId: "../../../../etc/passwd" }),
    ).rejects.toThrow(/unsafe/i);
  });

  it("容忍损坏的行 —— 半行写入不该毁掉整份历史", async () => {
    const sid = "3f4c20d8-ce64-42cf-a12b-d5a866be1f83";
    const dir = projectDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${sid}.jsonl`),
      [
        JSON.stringify({
          type: "assistant",
          message: { id: "ok", content: [{ type: "text", text: "好的" }] },
        }),
        '{"type":"assistant","message":{"content":[{"type":"text","tex',
      ].join("\n"),
    );
    const events = await transcript.read({ dataDir, workspaceDir, sdkSessionId: sid });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "text", text: "好的" });
  });
});

// 编码规则曾经漏了点(`.claude` 该编成 `--claude`),表现是历史一片空白而不报错 ——
// 静默正是这里最贵的失败方式。规则已修,但 SDK 对空格/中文等是否另有替换尚无实证,
// 所以留一层探针:文件读不到、而同名 jsonl 其实躺在隔壁目录时,必须留下痕迹。
describe("JsonlTranscript.read / 编码规则漂移探针", () => {
  it("同名 jsonl 落在别的目录时告警,并指出实际目录", async () => {
    const sid = "4f4c20d8-ce64-42cf-a12b-d5a866be1f84";
    // 模拟"编码规则对不上":文件写在一个我们推不出来的目录名下
    const strayDir = path.join(dataDir, ".agent-home", ".claude", "projects", "-some-other-coding");
    await fs.mkdir(strayDir, { recursive: true });
    await fs.writeFile(
      path.join(strayDir, `${sid}.jsonl`),
      `${JSON.stringify({ type: "assistant", message: { id: "x", content: [] } })}\n`,
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = await transcript.read({ dataDir, workspaceDir, sdkSessionId: sid });
      // 仍然返回空数组 —— 探针只负责留痕,不改变"缺失不是错误"的契约
      expect(events).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0]?.join(" ") ?? "";
      expect(msg).toContain("-some-other-coding");
    } finally {
      warn.mockRestore();
      await fs.rm(strayDir, { recursive: true, force: true });
    }
  });

  it("文件确实不存在时不告警 —— 工作空间被 GC 是常态,不该刷屏", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = await transcript.read({
        dataDir,
        workspaceDir,
        sdkSessionId: "5f4c20d8-ce64-42cf-a12b-d5a866be1f85",
      });
      expect(events).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  describe("同一 SDK 会话续接的多轮共用一份文件:按 uuid 截出本轮", () => {
    const SHARED = "6a1c20d8-ce64-42cf-a12b-d5a866be1f86";
    // 形状照抄 scripts/sdk-probe 实测的 jsonl:两轮都在同一个文件里,提示词行不在实时流里
    const line = (type: string, uuid: string, content: unknown) => ({
      type,
      uuid,
      cwd: workspaceDir,
      sessionId: SHARED,
      message: { id: `m-${uuid}`, content },
    });
    beforeAll(async () => {
      await writeTranscript(SHARED, [
        { type: "queue-operation", operation: "enqueue", sessionId: SHARED },
        line("user", "p1", "第一轮提示词"),
        line("assistant", "a1", [{ type: "text", text: "第一轮回答" }]),
        { type: "queue-operation", operation: "enqueue", sessionId: SHARED },
        line("user", "p2", "第二轮提示词"),
        line("assistant", "a2", [{ type: "tool_use", id: "t2", name: "Bash", input: {} }]),
        line("user", "r2", [{ type: "tool_result", tool_use_id: "t2", content: "ok" }]),
        line("assistant", "a3", [{ type: "text", text: "第二轮回答" }]),
      ]);
    });
    const read = (range?: { first: string; last: string }) =>
      transcript.read({ dataDir, workspaceDir, sdkSessionId: SHARED, range });
    const texts = (es: AgentEvent[]) => es.flatMap((e) => (e.kind === "text" ? [e.text] : []));

    it("各轮只读到自己的过程", async () => {
      expect(texts(await read({ first: "a1", last: "a1" }))).toEqual(["第一轮回答"]);
      const second = await read({ first: "a2", last: "a3" });
      expect(texts(second)).toEqual(["第二轮回答"]);
      expect(second.map((e) => e.kind)).toEqual(["tool_use", "tool_result", "text"]);
    });

    it("不给范围(旧数据)读整份", async () => {
      expect(texts(await read())).toEqual(["第一轮回答", "第二轮回答"]);
    });

    it("找不到起点:返回空,而不是把别的轮次当成本轮", async () => {
      expect(await read({ first: "nope", last: "a3" })).toEqual([]);
    });

    it("找不到终点(本轮写盘途中被杀):读到文件末尾", async () => {
      expect(texts(await read({ first: "a2", last: "nope" }))).toEqual(["第二轮回答"]);
    });
  });

  describe("运行中途追加的消息(两种落盘形态,按 scripts/sdk-probe/steer-*.mjs 实测)", () => {
    const SID2 = "7b1c20d8-ce64-42cf-a12b-d5a866be1f87";
    const base = { cwd: "/x", sessionId: SID2 };
    beforeAll(async () => {
      await writeTranscript(SID2, [
        { ...base, type: "user", uuid: "p1", message: { content: "本轮提示词" } },
        {
          ...base,
          type: "assistant",
          uuid: "a1",
          message: { id: "m1", content: [{ type: "text", text: "先答" }] },
        },
        // 插进当前这一轮
        {
          ...base,
          type: "attachment",
          uuid: "q1",
          attachment: {
            type: "queued_command",
            prompt: "插进来的 sk-ant-api03-SECRETSECRETSECRET",
            commandMode: "prompt",
          },
        },
        { ...base, type: "user", uuid: "meta", isMeta: true, message: { content: "系统提示" } },
        {
          ...base,
          type: "assistant",
          uuid: "a2",
          message: { id: "m2", content: [{ type: "text", text: "接着答" }] },
        },
        // 本轮回答之后再答一轮
        { ...base, type: "user", uuid: "p2", message: { content: "晚到的补充" } },
        {
          ...base,
          type: "assistant",
          uuid: "a3",
          message: { id: "m3", content: [{ type: "text", text: "补答" }] },
        },
      ]);
    });
    const kinds = (es: AgentEvent[]) =>
      es.map((e) =>
        e.kind === "steer" ? `steer:${e.text}` : e.kind === "text" ? `text:${e.text}` : e.kind,
      );

    it("按本轮范围读:两种形态都还原成 steer 事件,位置与发生顺序一致;提示词与系统提示不算", async () => {
      const es = await transcript.read({
        dataDir,
        workspaceDir,
        sdkSessionId: SID2,
        range: { first: "a1", last: "a3" },
      });
      expect(kinds(es).filter((k) => k.startsWith("steer") || k.startsWith("text"))).toEqual([
        "text:先答",
        expect.stringMatching(/^steer:插进来的 /),
        "text:接着答",
        "steer:晚到的补充",
        "text:补答",
      ]);
      // 与其余事件一样脱敏
      expect(JSON.stringify(es)).not.toContain("SECRETSECRET");
    });

    it("不给范围(旧数据)读整份:普通用户文本不认作追加 —— 那里面有各轮的提示词", async () => {
      const es = await transcript.read({ dataDir, workspaceDir, sdkSessionId: SID2 });
      const steers = es.filter((e) => e.kind === "steer");
      expect(steers).toHaveLength(1); // 只有 queued_command 那一条
    });
  });
});
