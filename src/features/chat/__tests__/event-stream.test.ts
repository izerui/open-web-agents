import { createSseParser } from "@/features/chat/event-stream";
import { describe, expect, it } from "vitest";

describe("createSseParser", () => {
  it("解析单个完整帧", () => {
    const parse = createSseParser();
    expect(parse('data: {"kind":"text","text":"hi"}\n\n')).toEqual([{ kind: "text", text: "hi" }]);
  });

  it("一个 chunk 里的多帧全部解析", () => {
    const parse = createSseParser();
    const out = parse('data: {"kind":"text","text":"a"}\n\ndata: {"kind":"text","text":"b"}\n\n');
    expect(out.map((e) => (e.kind === "text" ? e.text : ""))).toEqual(["a", "b"]);
  });

  it("跨 chunk 的半截帧被缓冲到完整为止", () => {
    const parse = createSseParser();
    expect(parse('data: {"kind":"te')).toEqual([]);
    expect(parse('xt","text":"hi"}\n\n')).toEqual([{ kind: "text", text: "hi" }]);
  });

  it("损坏的 JSON 被丢弃,不打断后续帧", () => {
    const parse = createSseParser();
    const out = parse('data: {broken\n\ndata: {"kind":"text","text":"ok"}\n\n');
    expect(out).toEqual([{ kind: "text", text: "ok" }]);
  });

  it("忽略空 data 与非 data 行", () => {
    const parse = createSseParser();
    expect(parse(': comment\ndata:\n\ndata: {"kind":"text","text":"x"}\n\n')).toEqual([
      { kind: "text", text: "x" },
    ]);
  });

  it("尾部未闭合的帧不吐出", () => {
    const parse = createSseParser();
    expect(parse('data: {"kind":"text","text":"partial"}')).toEqual([]);
  });
});
