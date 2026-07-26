import { isTextMime, mimeOf } from "@/lib/modules/artifacts/domain/mime";
import { describe, expect, it } from "vitest";

describe("mimeOf", () => {
  it("识别常见文本类型", () => {
    expect(mimeOf("a.md")).toBe("text/markdown");
    expect(mimeOf("a.json")).toBe("application/json");
    expect(mimeOf("a.py")).toBe("text/x-python");
  });
  it("识别常见二进制类型", () => {
    expect(mimeOf("a.png")).toBe("image/png");
    expect(mimeOf("a.mp4")).toBe("video/mp4");
  });
  it("大小写不敏感", () => {
    expect(mimeOf("A.PNG")).toBe("image/png");
  });
  it("多点文件名取最后一段扩展名", () => {
    expect(mimeOf("report.final.md")).toBe("text/markdown");
  });
  it("无扩展名或未知扩展名归为八位字节流", () => {
    expect(mimeOf("Makefile")).toBe("application/octet-stream");
    expect(mimeOf("a.xyz")).toBe("application/octet-stream");
  });
});

describe("isTextMime", () => {
  it("text/* 与 json 可文本预览", () => {
    expect(isTextMime("text/markdown")).toBe(true);
    expect(isTextMime("application/json")).toBe(true);
  });
  it("二进制不做文本预览", () => {
    expect(isTextMime("image/png")).toBe(false);
    expect(isTextMime("application/octet-stream")).toBe(false);
  });
});
