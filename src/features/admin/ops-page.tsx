"use client";

import { SpaceShellEmbed } from "@/components/space-shell";
import { AuditView } from "@/features/audit/audit-view";
import { RunsView } from "@/features/runs/runs-view";
import { UsageView } from "@/features/usage/usage-view";
import { AdminPage, AdminTabs, useTabParam } from "./admin-ui";

const TABS = [
  { value: "usage", label: "平台用量" },
  { value: "runs", label: "平台运行" },
  { value: "audit", label: "平台审计" },
] as const;
type Tab = (typeof TABS)[number]["value"];

/**
 * 平台运行与用量（原 /admin/usage、/admin/runs、/admin/audit 三页合一）。
 * 三个视图与个人页共用，这里只做外层组合：SpaceShellEmbed 让它们不再各自套外壳。
 */
export function OpsPage() {
  const [tab, setTab] = useTabParam<Tab>(
    TABS.map((t) => t.value),
    "usage",
  );
  return (
    <AdminPage
      title="平台运行与用量"
      subtitle="全平台的 token 用量、所有账号的运行和操作记录。会话内容是私有的，这里看不到对话。"
      tabs={<AdminTabs label="平台运行与用量" items={TABS} value={tab} onChange={setTab} />}
    >
      <div className="pt-2">
        <SpaceShellEmbed>
          {tab === "usage" && <UsageView scope="all" />}
          {tab === "runs" && <RunsView platform />}
          {tab === "audit" && <AuditView platform />}
        </SpaceShellEmbed>
      </div>
    </AdminPage>
  );
}
