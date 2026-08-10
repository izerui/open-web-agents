import { canRenderInline, isTextMime, mimeOf } from "@/lib/modules/artifacts/domain/mime";
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

describe("canRenderInline —— 内联渲染的安全边界", () => {
  it("图片放行", () => {
    for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(canRenderInline(m)).toBe(true);
    }
  });

  it("HTML 绝不放行 —— 同源内联渲染 agent 产物等于 XSS", () => {
    expect(canRenderInline("text/html")).toBe(false);
  });

  it("其余文本与二进制一律不放行", () => {
    for (const m of [
      "text/plain",
      "application/json",
      "application/pdf",
      "application/zip",
      "application/octet-stream",
      "video/mp4",
    ]) {
      expect(canRenderInline(m)).toBe(false);
    }
  });

  it("SVG 放行,但依赖响应头兜底(CSP sandbox + nosniff)", () => {
    expect(canRenderInline("image/svg+xml")).toBe(true);
  });
});
