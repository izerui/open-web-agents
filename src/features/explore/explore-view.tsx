"use client";

import { AppShell } from "@/components/shell/app-shell";
import { AskPanel } from "./ask-panel";
import { AvatarRow } from "./avatar-row";
import { MarketSection } from "./market-section";
import { RecentWork } from "./recent-work";

/**
 * 探索首页(coze-v3,原 /market):说一件事 → 智能体设计器做一个或推荐已有智能体;
 * 你的 AI 同事正在工作(最近会话);市场。
 */
export function ExploreView() {
  return (
    <AppShell>
      <div className="flex flex-col items-center px-5 pt-11 pb-10 max-md:pt-8">
        <AvatarRow size={60} avatarClassName="max-md:size-11" />
        <h1 className="mt-[22px] mb-2.5 text-center font-display text-[52px] leading-tight font-bold max-md:text-[34px]">
          想交给它什么事？
        </h1>
        <p className="mb-[26px] text-center text-[17px] text-muted-foreground max-md:text-base">
          说一件事，市场里的智能体接手；没有合适的，智能体设计器现场给你做一个。
        </p>
        <AskPanel />
      </div>
      <RecentWork />
      <MarketSection />
    </AppShell>
  );
}
