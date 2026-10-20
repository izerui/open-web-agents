import { SpaceShell } from "@/components/space-shell";
import { PriceList } from "@/features/capabilities/price-list";
import Link from "next/link";

/** 仅接收公开状态,提供者、平台地址、模型 ID 与密钥不进入页面数据。 */
export function CredentialsView({ configured }: { configured: boolean }) {
  return (
    <SpaceShell title="平台算力" width="narrow">
      <dl className="divide-y divide-border text-sm">
        <div className="grid gap-2 py-4 sm:grid-cols-[9rem_1fr]">
          <dt className="text-muted-foreground">算力来源</dt>
          <dd>平台统一提供</dd>
        </div>
        <div className="grid gap-2 py-4 sm:grid-cols-[9rem_1fr]">
          <dt className="text-muted-foreground">平台凭证</dt>
          <dd>{configured ? "已配置" : "待配置，请联系管理员"}</dd>
        </div>
        <div className="grid gap-2 py-4 sm:grid-cols-[9rem_1fr]">
          <dt className="text-muted-foreground">AI 智能体设计</dt>
          <dd>使用平台算力</dd>
        </div>
      </dl>
      <nav aria-label="算力相关页面" className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
        <Link className="text-primary underline underline-offset-4" href="/settings/usage">
          用量与成本
        </Link>
        <Link className="text-primary underline underline-offset-4" href="/settings/keys">
          接入中心与 API Key
        </Link>
      </nav>
      <PriceList />
    </SpaceShell>
  );
}
