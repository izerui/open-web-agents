import { describe, expect, it } from "vitest";
import { authSuccessText, shouldClearPassword, validateAuthForm } from "../auth-form";

describe("validateAuthForm", () => {
  it("登录:空邮箱、空密码逐项提示", () => {
    expect(validateAuthForm({ mode: "login", email: " ", password: "", confirm: "" })).toEqual({
      email: "请输入邮箱",
      password: "请输入密码",
    });
  });

  it("登录:邮箱格式不对;登录不查 8 位下限(老账号可能更短)", () => {
    expect(validateAuthForm({ mode: "login", email: "abc", password: "123", confirm: "" })).toEqual(
      { email: "邮箱格式不对" },
    );
  });

  it("注册:密码至少 8 位", () => {
    expect(
      validateAuthForm({ mode: "register", email: "a@b.co", password: "1234567", confirm: "" }),
    ).toEqual({ password: "密码至少 8 位" });
  });

  it("注册一律要求再次输入密码,不一致时提示在确认框下", () => {
    expect(
      validateAuthForm({ mode: "register", email: "a@b.co", password: "12345678", confirm: "" }),
    ).toEqual({ confirm: "两次输入的密码不一致" });
    expect(
      validateAuthForm({
        mode: "register",
        email: "a@b.co",
        password: "12345678",
        confirm: "12345679",
      }),
    ).toEqual({ confirm: "两次输入的密码不一致" });
  });

  it("其他字段已有错时不再追加「不一致」(先改前面的)", () => {
    expect(
      validateAuthForm({ mode: "register", email: "", password: "12345678", confirm: "x" }),
    ).toEqual({ email: "请输入邮箱" });
  });

  it("全部正确返回空对象", () => {
    expect(
      validateAuthForm({
        mode: "register",
        email: " a@b.co ",
        password: "12345678",
        confirm: "12345678",
      }),
    ).toEqual({});
    expect(
      validateAuthForm({ mode: "login", email: "a@b.co", password: "x", confirm: "" }),
    ).toEqual({});
  });
});

describe("shouldClearPassword", () => {
  it("登录时账号或密码错(401)清空密码", () => {
    expect(shouldClearPassword("login", 401)).toBe(true);
  });
  it("限流、网络错误、注册失败不清空", () => {
    expect(shouldClearPassword("login", 429)).toBe(false);
    expect(shouldClearPassword("login", null)).toBe(false);
    expect(shouldClearPassword("register", 409)).toBe(false);
  });
});

describe("authSuccessText", () => {
  it("三种成功提示", () => {
    expect(authSuccessText("login", false)).toBe("登录成功");
    expect(authSuccessText("register", false)).toBe("账号已创建");
    expect(authSuccessText("register", true)).toBe("管理员账号已创建");
  });
});
