import {
  BarChart3,
  Bot,
  Cpu,
  History,
  Lock,
  MessageSquare,
  Package,
  ScrollText,
  Server,
  Store,
  Terminal,
  Users,
  Wallet,
} from "lucide-react";

export type NavItem = { href: string; label: string; icon: typeof Bot };

/**
 * 企业账号自己的配置项 —— 都是低频动作。
 *
 * 【为什么不含智能体】它是核心创作物,不是一项配置,在工具窗口条上有自己的入口。
 * 【为什么不含用户组】一个账号就是一家企业,内部不分人,组没有存在意义。
 */
export const PERSONAL_NAV: readonly NavItem[] = [
  { href: "/settings/audit", label: "审计日志", icon: ScrollText },
  { href: "/settings/account", label: "账号安全", icon: Lock },
  { href: "/settings/keys", label: "API Key 与接入", icon: Terminal },
];

export const BILLING_NAV: readonly NavItem[] = [
  { href: "/settings/billing", label: "账户与消耗", icon: Wallet },
  { href: "/settings/usage", label: "用量分析", icon: BarChart3 },
  { href: "/settings/packages", label: "充值与订单", icon: Package },
  { href: "/settings/credentials", label: "模型价格", icon: Cpu },
];

export const WORKSPACE_NAV: readonly NavItem[] = [
  { href: "/", label: "智能体工作区", icon: MessageSquare },
  { href: "/agents", label: "智能体配置", icon: Bot },
  { href: "/agents?new=1", label: "新建智能体", icon: Bot },
  { href: "/market", label: "发现智能体", icon: Store },
  { href: "/settings/runs", label: "全部运行", icon: History },
];
/**
 * 平台运营方的管理项 —— 数据范围是所有企业账号。
 *
 * 账号管理排在前面:运营日常真正要做的是"谁在用、谁在烧钱、谁该停",
 * 而不是先看一张总量图表。
 */
export const ADMIN_NAV: readonly NavItem[] = [
  { href: "/admin/accounts", label: "账号管理", icon: Users },
  { href: "/admin/providers", label: "提供者与路由", icon: Server },
  { href: "/admin/models", label: "模型总览", icon: Cpu },
  { href: "/admin/billing", label: "计费管理", icon: Wallet },
  { href: "/admin/packages", label: "套餐与订单", icon: Package },
  { href: "/admin/usage", label: "全平台 token 用量", icon: BarChart3 },
  { href: "/admin/runs", label: "平台运行", icon: History },
  { href: "/admin/audit", label: "平台审计", icon: ScrollText },
  { href: "/admin/market", label: "市场管理", icon: Store },
];
