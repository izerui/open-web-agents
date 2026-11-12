"use client";

import { BrandMark } from "@/components/shell/brand-mark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AvatarRow } from "@/features/explore/avatar-row";
import { errorText } from "@/lib/fetch-json";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  type AuthFieldErrors,
  type AuthMode,
  authSuccessText,
  shouldClearPassword,
  validateAuthForm,
} from "./auth-form";

const MODES = {
  login: { title: "登录以继续", lead: "用你的邮箱和密码登录。", submit: "登录" },
  register: {
    title: "创建账号",
    lead: "注册后是普通账号，可以使用市场里的智能体，也能搭建自己的。",
    submit: "创建账号",
  },
  first: {
    title: "创建管理员账号",
    lead: "欢迎使用 Open Web Agents。先创建第一个账号。",
    submit: "创建管理员账号",
  },
} as const;

export function LoginForm({
  firstRun,
  allowSignup,
}: {
  firstRun: boolean;
  /** 平台关闭自助注册时不展示注册入口(第一个账号始终可以注册)。 */
  allowSignup: boolean;
}) {
  const router = useRouter();
  // 首次部署(库里还没有用户)默认落在注册页,省掉"先注册再登录"的困惑
  const [mode, setMode] = useState<AuthMode>(firstRun ? "register" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors>({});
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  // 注册一律要求再输一遍密码(取舍 9):首次部署建的是管理员,普通注册打错一个字符也只能找管理员重置
  const needConfirm = mode === "register";
  const copy = MODES[mode === "register" ? (firstRun ? "first" : "register") : "login"];

  async function submit() {
    if (busy) return;
    const errors = validateAuthForm({ mode, email, password, confirm });
    setFieldErrors(errors);
    if (errors.email) return emailRef.current?.focus();
    if (errors.password) return passwordRef.current?.focus();
    if (errors.confirm) return confirmRef.current?.focus();
    setBusy(true);
    setError(null);
    let status: number | null = null;
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, email: email.trim(), password }),
      });
      status = res.status;
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `请求失败（HTTP ${res.status}）`);
      toast.success(authSuccessText(mode, firstRun));
      router.replace("/");
      router.refresh();
    } catch (e) {
      setError(errorText(e));
      if (shouldClearPassword(mode, status)) {
        setPassword("");
        // 等清空后的值渲染完再聚焦
        requestAnimationFrame(() => passwordRef.current?.focus());
      }
    } finally {
      setBusy(false);
    }
  }

  function field(name: keyof AuthFieldErrors) {
    const message = fieldErrors[name];
    return {
      "aria-invalid": message ? true : undefined,
      "aria-describedby": message ? `login-${name}-error` : undefined,
    } as const;
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-8 max-md:items-start max-md:p-4">
      <div className="grid min-h-[580px] w-full max-w-[980px] grid-cols-[minmax(0,1fr)_440px] overflow-hidden rounded-3xl border border-border bg-card shadow-[0_20px_60px_rgb(60_50_30/7%)] max-md:min-h-0 max-md:grid-cols-1">
        {/* 手机上头图只留一行品牌,不把表单挤到首屏下半部分 */}
        <section className="flex flex-col bg-band px-11 py-10 max-md:px-6 max-md:py-4">
          <div className="flex items-center gap-2.5 text-[15px] font-semibold">
            {/* 和顶栏同一个徽标 —— 登录是第一眼,不该是唯一没有品牌的页面 */}
            <BrandMark />
            Open Web Agents
          </div>
          <AvatarRow
            size={54}
            ringClassName="ring-band"
            avatarClassName="max-md:size-9"
            className="mt-14 max-md:hidden"
          />
          <h1 className="mt-7 mb-3.5 font-display text-[38px] leading-[1.3] font-bold max-md:sr-only">
            把要做的事，
            <br />
            交给会做事的 AI 同事。
          </h1>
          <p className="text-[15px] leading-[1.7] text-muted-foreground max-md:hidden">
            在市场里找一个直接用，或者说清规则搭一个自己的：评测通过再发布，用 API 接进你的系统。
          </p>
          <p className="mt-auto pt-6 text-[13px] text-muted-foreground max-md:hidden">
            自部署版本，数据保存在你们自己的服务器上。
          </p>
        </section>

        <section className="flex flex-col px-11 pt-11 pb-9 max-md:px-6 max-md:pt-7 max-md:pb-8">
          <h2 className="mb-1.5 font-display text-[28px] leading-tight font-bold">{copy.title}</h2>
          <p className="mb-6 text-sm text-muted-foreground">{copy.lead}</p>

          {mode === "register" && firstRun && (
            <div className="mb-[18px] flex gap-2.5 rounded-xl bg-[#F2F1EC] px-3.5 py-3 text-sm text-[#3C3A35]">
              <ShieldCheck className="mt-0.5 size-[18px] shrink-0" aria-hidden="true" />
              <p>
                这是这台部署的第一个账号，会自动成为<b>平台管理员</b>
                ，可以管理账号、模型与提供者、市场上架和计费。
              </p>
            </div>
          )}

          {/* 原来是硬编码的 text-red-600,不跟主题走 */}
          {error && (
            <Alert
              variant="destructive"
              className="mb-3.5 rounded-xl border-0 bg-destructive-soft px-3 py-2.5"
            >
              <AlertTriangle />
              <AlertDescription className="break-words text-destructive">{error}</AlertDescription>
            </Alert>
          )}

          {/*
            真正的 <form>:任一输入框回车都能提交,密码管理器也能识别。
            曾经只有密码框监听回车,且没判断输入法组合输入,中文输入法选字时会误提交。
          */}
          <form
            noValidate
            className="flex flex-col gap-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] text-muted-foreground">邮箱</span>
              <Input
                ref={emailRef}
                type="email"
                name="email"
                autoComplete="email"
                placeholder="name@company.com"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11 text-base md:text-[15px]"
                {...field("email")}
              />
              <FieldError id="login-email-error" message={fieldErrors.email} />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] text-muted-foreground">密码</span>
              <Input
                ref={passwordRef}
                type="password"
                name="password"
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                placeholder={mode === "register" ? "至少 8 位" : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 text-base md:text-[15px]"
                {...field("password")}
              />
              <FieldError id="login-password-error" message={fieldErrors.password} />
            </label>

            {needConfirm && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] text-muted-foreground">再次输入密码</span>
                <Input
                  ref={confirmRef}
                  type="password"
                  name="confirm-password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="h-11 text-base md:text-[15px]"
                  {...field("confirm")}
                />
                <FieldError id="login-confirm-error" message={fieldErrors.confirm} />
              </label>
            )}

            <Button type="submit" className="mt-1.5 h-[46px] w-full text-[15px]" disabled={busy}>
              {busy && (
                <span
                  aria-hidden="true"
                  className="size-4 animate-spin rounded-full border-2 border-[#8A867C] border-t-white"
                />
              )}
              {busy ? "处理中…" : copy.submit}
            </Button>
          </form>

          {firstRun ? null : allowSignup ? (
            <p className="mt-[18px] text-center text-sm text-muted-foreground">
              {mode === "login" ? "还没有账号？" : "已有账号？"}
              <Button
                type="button"
                variant="link"
                className="h-auto px-0 text-sm max-md:min-h-11"
                onClick={() => {
                  setMode(mode === "login" ? "register" : "login");
                  setError(null);
                  setFieldErrors({});
                  setConfirm("");
                }}
              >
                {mode === "login" ? "去注册" : "去登录"}
              </Button>
            </p>
          ) : (
            <p className="mt-[18px] text-center text-sm text-muted-foreground">
              需要账号请联系平台管理员
            </p>
          )}
          <p className="mt-6 text-center text-xs text-muted-foreground">
            登录和注册按 IP 与账号限流，连续输错会暂时锁定一段时间
          </p>
        </section>
      </div>
    </main>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <span id={id} className="text-[13px] text-destructive">
      {message}
    </span>
  );
}
