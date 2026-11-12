"use client";

import { SpaceShellEmbed } from "@/components/space-shell";
import { type AdminView, BillingView } from "@/features/billing/billing-view";
import { useSearchParams } from "next/navigation";
import { AdminPage } from "./admin-ui";
import { tabFrom } from "./tab-param";

const VIEWS: readonly AdminView[] = ["overview", "accounts", "reconciliation"];

/**
 * 平台管理 · 计费（概览 / 账户 / 对账）。BillingView 与个人页共用，
 * 这里只套新外壳与标题；分区页签在 BillingView 的管理分支里，初始分区取地址 ?tab=。
 */
export function BillingAdmin() {
  const initial = tabFrom(useSearchParams().get("tab"), VIEWS, "overview");
  return (
    <AdminPage
      title="计费"
      subtitle="全平台积分消耗、账户与人工发放、按提供者对账。1 元 = 100 积分。"
    >
      <SpaceShellEmbed>
        <BillingView admin initialAdminView={initial} />
      </SpaceShellEmbed>
    </AdminPage>
  );
}
