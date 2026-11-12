import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * 设计令牌的可读性底线(coze-v3「对话搭建」):正文对比度 ≥4.5:1,主文字 ≥7:1。
 * 读的是 globals.css 的原文,改色值时这里会先红 —— 原型审查时灰绿标签就是 4.34 没过线。
 */
const css = readFileSync(fileURLToPath(new URL("../globals.css", import.meta.url)), "utf8");

function rootVars(): Record<string, string> {
  const block = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
  const vars: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) {
    if (name && value) vars[name] = value;
  }
  return vars;
}

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("设计令牌", () => {
  const v = rootVars();
  const pair = (fg: string, bg: string) => {
    const [a, b] = [v[fg], v[bg]];
    expect(a, `缺少 --${fg}`).toBeDefined();
    expect(b, `缺少 --${bg}`).toBeDefined();
    return contrast(a ?? "#000000", b ?? "#000000");
  };

  it("主文字在底色上 ≥7:1", () => {
    expect(pair("foreground", "background")).toBeGreaterThanOrEqual(7);
  });

  it("次要文字在底色与卡片上都 ≥4.5:1", () => {
    expect(pair("muted-foreground", "background")).toBeGreaterThanOrEqual(4.5);
    expect(pair("muted-foreground", "card")).toBeGreaterThanOrEqual(4.5);
  });

  it("状态标签的文字在各自浅底上 ≥4.5:1", () => {
    expect(pair("success-text", "success-soft")).toBeGreaterThanOrEqual(4.5);
    expect(pair("warning-text", "warning-soft")).toBeGreaterThanOrEqual(4.5);
    expect(pair("destructive", "destructive-soft")).toBeGreaterThanOrEqual(4.5);
  });

  it("主按钮文字 ≥7:1", () => {
    expect(pair("primary-foreground", "primary")).toBeGreaterThanOrEqual(7);
  });

  it("只有浅色主题", () => {
    expect(css).not.toMatch(/\.dark\s*\{/);
  });
});
