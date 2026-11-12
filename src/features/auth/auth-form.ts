// 登录 / 注册表单的纯逻辑:逐字段校验、失败后是否清空密码、成功提示。界面只管渲染。

export type AuthMode = "login" | "register";

export interface AuthFields {
  mode: AuthMode;
  email: string;
  password: string;
  confirm: string;
}

export type AuthFieldErrors = Partial<Record<"email" | "password" | "confirm", string>>;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * 前端逐字段校验(与原型一致):错误写在各字段下面,按钮不预先置灰。
 * - 登录不查 8 位下限:服务端只对新设的密码有这条规则
 * - 注册一律要求再次输入密码;前面已有错时先不报「不一致」
 */
export function validateAuthForm({ mode, email, password, confirm }: AuthFields): AuthFieldErrors {
  const errors: AuthFieldErrors = {};
  const e = email.trim();
  if (!e) errors.email = "请输入邮箱";
  else if (!EMAIL.test(e)) errors.email = "邮箱格式不对";
  if (!password) errors.password = "请输入密码";
  else if (mode === "register" && password.length < 8) errors.password = "密码至少 8 位";
  if (mode === "register" && Object.keys(errors).length === 0 && confirm !== password) {
    errors.confirm = "两次输入的密码不一致";
  }
  return errors;
}

/** 登录时账号或密码不对(401)清空密码框并聚焦;限流、断网、注册失败保留输入。 */
export function shouldClearPassword(mode: AuthMode, status: number | null): boolean {
  return mode === "login" && status === 401;
}

export function authSuccessText(mode: AuthMode, firstRun: boolean): string {
  if (mode === "login") return "登录成功";
  return firstRun ? "管理员账号已创建" : "账号已创建";
}
