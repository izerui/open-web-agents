"use client";

import { PriceList } from "@/features/capabilities/price-list";
import { SpacePage } from "@/features/settings/space-page";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check, Cpu } from "lucide-react";
import Link from "next/link";

/** 仅接收公开状态,提供者、平台地址、模型 ID 与密钥不进入页面数据。 */
export function CredentialsView({ configured }: { configured: boolean }) {
  return (
    <SpacePage
      side="account"
      title="模型价格"
      subtitle="运行按模型实际用量扣积分。1 元 = 100 积分，价目由管理员维护，调整后对之后的运行生效。"
    >
      <div className="mb-[18px] grid gap-3.5 md:grid-cols-2">
        <div className="flex items-start gap-3.5 rounded-2xl border border-border bg-card px-[22px] py-[18px]">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#F1EFEA]">
            <Cpu className="size-5" />
          </span>
          <div>
            <h2 className="mb-0.5 text-[15px] font-semibold">算力来源：平台统一提供</h2>
            <p className="text-sm text-muted-foreground">
              不需要自己配置模型 Key。所有运行都走平台的模型提供者，按下表价目从积分里扣。
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3.5 rounded-2xl border border-border bg-card px-[22px] py-[18px]">
          <span
            className={cn(
              "grid size-10 shrink-0 place-items-center rounded-xl",
              configured ? "bg-success-soft text-success" : "bg-warning-soft text-warning-text",
            )}
          >
            {configured ? <Check className="size-5" /> : <AlertTriangle className="size-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="mb-0.5 text-[15px] font-semibold">
              平台配置状态：
              <span className={configured ? "text-success-text" : "text-warning-text"}>
                {configured ? "已配置" : "待配置，请联系管理员"}
              </span>
            </h2>
            <p className="mb-2 text-sm text-muted-foreground">
              {configured
                ? "文本模型可以正常运行。"
                : "管理员还没配置模型提供者，现在发起运行会失败。"}
            </p>
            <nav aria-label="费用相关页面" className="flex flex-wrap gap-x-3.5 gap-y-2 text-sm">
              <Link
                className="underline decoration-[#C9C4B8] underline-offset-[3px]"
                href="/account/usage"
              >
                用量分析
              </Link>
              <Link
                className="underline decoration-[#C9C4B8] underline-offset-[3px]"
                href="/account/billing"
              >
                积分与套餐
              </Link>
            </nav>
          </div>
        </div>
      </div>
      <PriceList configured={configured} />
    </SpacePage>
  );
}
