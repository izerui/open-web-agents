import { describe, expect, it } from "vitest";
import { ownerFilter, resolveScope } from "../scope";

describe("resolveScope", () => {
  it("admin 显式请求 all 才给全平台", () => {
    expect(resolveScope("all", true)).toBe("all");
  });

  it("admin 不请求 all 时只看自己 —— 身份不该隐式放大范围", () => {
    /*
     * 【为什么单独测这条】原来的实现是「是 admin 就给全部」,
     * 导致「我的组」页面对管理员会列出全平台的组,名不副实。
     * 范围必须由调用方说清楚。
     */
    expect(resolveScope(null, true)).toBe("self");
    expect(resolveScope("self", true)).toBe("self");
  });

  it("非 admin 请求 all 静默降级,不报错也不放行", () => {
    expect(resolveScope("all", false)).toBe("self");
  });

  it("无法识别的取值一律当 self —— 拼错不该等于提权", () => {
    for (const raw of ["ALL", "全部", "true", "1", "", "al"]) {
      expect(resolveScope(raw, true)).toBe("self");
    }
  });
});

describe("ownerFilter", () => {
  it("self 带上 userId,all 不加过滤", () => {
    expect(ownerFilter("self", "u1")).toBe("u1");
    expect(ownerFilter("all", "u1")).toBeUndefined();
  });
});
