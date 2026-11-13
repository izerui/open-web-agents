import { describe, expect, it } from "vitest";
import { externalLinkTarget } from "../external-link";

describe("externalLinkTarget：外链确认框里显示要去哪", () => {
  it("http(s) 链接只显示域名（带端口时保留端口）", () => {
    expect(externalLinkTarget("https://www.example.com/a/b?c=1#d")).toBe("www.example.com");
    expect(externalLinkTarget("http://erp.finance.example.cn:8080/x")).toBe("erp.finance.example.cn:8080");
  });

  it("邮件链接显示邮箱地址", () => {
    expect(externalLinkTarget("mailto:finance@example.com?subject=hi")).toBe("finance@example.com");
  });

  it("解析不了或其他协议时显示原地址，太长截断", () => {
    expect(externalLinkTarget("tel:12345")).toBe("tel:12345");
    expect(externalLinkTarget("not a url")).toBe("not a url");
    const shown = externalLinkTarget(`ftp://${"a".repeat(100)}`);
    expect(shown.length).toBeLessThanOrEqual(61);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("空地址给空串", () => {
    expect(externalLinkTarget("")).toBe("");
  });
});
