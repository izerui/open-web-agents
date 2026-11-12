"use client";

// 构建页里反复出现的小部件(原型 owa.css 的 .tag .banner .fld .seg .sub-h .stage-h .blk .code .radio)。

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { Tone } from "./build-model";

export function Tag({
  tone = "",
  line = false,
  className,
  children,
  title,
}: {
  tone?: Tone;
  line?: boolean;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  const variant = line
    ? "outline"
    : tone === "ok"
      ? "success"
      : tone === "warn"
        ? "warning"
        : tone === "bad"
          ? "destructive"
          : "default";
  return (
    <Badge variant={variant} className={cn("font-normal", className)} title={title}>
      {children}
    </Badge>
  );
}

export function Banner({
  tone = "info",
  icon,
  children,
  action,
  className,
}: {
  tone?: "info" | "ok" | "warn" | "bad";
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-4 flex items-center gap-3 rounded-[14px] px-4 py-3 text-sm max-md:flex-wrap",
        tone === "ok" && "bg-success-soft text-[#2C5C40]",
        tone === "warn" && "bg-warning-soft text-warning-text",
        tone === "bad" && "bg-destructive-soft text-destructive",
        tone === "info" && "bg-[#F2F1EC] text-[#3C3A35]",
        className,
      )}
    >
      {icon && <span className="shrink-0 [&_svg]:size-[18px]">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="shrink-0 max-md:w-full">{action}</div>}
    </div>
  );
}

export function Field({
  label,
  required,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mb-3.5 flex min-w-0 flex-col gap-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="flex items-center gap-2 text-[13px] text-muted-foreground"
      >
        <span>
          {label}
          {required && <b className="ml-0.5 font-medium text-destructive">*</b>}
        </span>
      </label>
      {children}
      {error ? (
        <span className="text-xs text-destructive" aria-live="polite">
          {error}
        </span>
      ) : hint ? (
        <span className="text-[13px] text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

export function Seg<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  disabled,
}: {
  options: readonly (
    | readonly [T, ReactNode]
    | readonly [T, ReactNode, { disabled?: boolean; title?: string }]
  )[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <fieldset
      aria-label={ariaLabel}
      className={cn(
        "m-0 inline-flex max-w-full min-w-0 flex-wrap rounded-[20px] border-0 bg-[#ECEAE3] p-[3px]",
        className,
      )}
    >
      {options.map((o) => {
        const [v, label, opt] = o as readonly [
          T,
          ReactNode,
          { disabled?: boolean; title?: string }?,
        ];
        const on = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled || opt?.disabled}
            title={opt?.title}
            onClick={() => onChange(v)}
            className={cn(
              "h-[30px] rounded-[15px] px-3.5 text-[13px] whitespace-nowrap text-muted-foreground disabled:cursor-not-allowed disabled:opacity-55 max-md:h-10",
              on && "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,.06)]",
            )}
          >
            {label}
          </button>
        );
      })}
    </fieldset>
  );
}

export function SubHead({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mt-3.5 mb-2 flex flex-wrap items-center justify-between gap-2 text-[13px] font-semibold">
      <span>{children}</span>
      {right && <span className="flex items-center gap-1.5 font-normal">{right}</span>}
    </div>
  );
}

export function StageTitle({
  title,
  desc,
  right,
}: {
  title: ReactNode;
  desc?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 className="m-0 font-display text-[26px] leading-tight font-bold">{title}</h2>
        {desc && <div className="mt-1 max-w-[680px] text-sm text-muted-foreground">{desc}</div>}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}

export function Block({
  icon,
  title,
  right,
  children,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("mb-4 rounded-2xl border border-border px-5 py-[18px] max-md:px-4", className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 flex items-center gap-2 text-base font-semibold [&_svg]:size-4">
          {icon}
          {title}
        </h3>
        {right && <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>}
      </div>
      {children}
    </section>
  );
}

export function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "m-0 overflow-auto rounded-xl bg-[#1F1E1C] px-4 py-3.5 font-mono text-[13px] leading-[1.65] whitespace-pre text-[#EAE6DC]",
        className,
      )}
    >
      {children}
    </pre>
  );
}

export function RadioRow({
  on,
  onSelect,
  title,
  hint,
  inline,
}: {
  on: boolean;
  onSelect: () => void;
  title: ReactNode;
  hint?: ReactNode;
  inline?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onSelect}
      className="flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left hover:bg-[#F6F5F1]"
    >
      <span
        className={cn(
          "mt-[3px] size-4 shrink-0 rounded-full border-[1.5px] border-[#B5B0A4]",
          on && "border-[5px] border-foreground",
        )}
      />
      <span className={cn("min-w-0", inline && "flex flex-wrap items-baseline gap-x-2")}>
        <span className="block font-medium">{title}</span>
        {hint && <span className="block text-[13px] text-muted-foreground">{hint}</span>}
      </span>
    </button>
  );
}

export function CopyButton({
  text,
  label = "复制",
  done = "已复制",
  className,
  variant = "ghost",
}: {
  text: string;
  label?: string;
  done?: string;
  className?: string;
  variant?: "ghost" | "outline";
}) {
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => toast.success(done),
          () => toast.error("复制失败，请手动选择文本"),
        )
      }
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] text-[#4D4A43] hover:bg-accent max-md:h-11",
        variant === "outline" && "border border-border bg-card",
        className,
      )}
    >
      <Copy className="size-3.5" />
      {label}
    </button>
  );
}

/** 原型 .ibtn:无底色的小文字按钮 */
export function TextButton({ children, className, ...rest }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] whitespace-nowrap text-[#4D4A43] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 max-md:h-11 [&_svg]:size-3.5",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** 上线清单 / 用例的圆形状态 */
export function CheckDot({
  tone,
  size = 18,
}: { tone: "ok" | "bad" | "warn" | "wait"; size?: number }) {
  return (
    <span
      style={{ width: size, height: size }}
      className={cn(
        "grid shrink-0 place-items-center rounded-full",
        tone === "ok" && "bg-success text-white",
        tone === "bad" && "bg-destructive-soft text-destructive",
        tone === "warn" && "border border-[#EBCB91] bg-warning-soft text-warning-text",
        tone === "wait" && "border-[1.5px] border-[#C9C4B8]",
      )}
    >
      {tone === "ok" && <Check className="size-[60%]" strokeWidth={3} />}
    </span>
  );
}

export const inputMono = "font-mono text-[13px]";
