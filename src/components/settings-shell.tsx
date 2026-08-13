"use client";

import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { UserMenu } from "@/components/user-menu";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  BarChart3,
  type Bot,
  KeyRound,
  ShieldCheck,
  Terminal,
  User,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 企业账号自己的配置项 —— 都是低频动作。
 *
 * 【为什么不含智能体】它是核心创作功能,已提到主导航(app-sidebar.tsx)。
 * 【为什么不含用户组】一个账号就是一家企业,内部不分人,组没有存在意义。
 */
export const PERSONAL_NAV = [
  { href: "/settings/keys", label: "接入与 API Key", icon: Terminal },
  { href: "/settings/usage", label: "用量与成本", icon: BarChart3 },
  { href: "/settings/credentials", label: "模型凭证", icon: KeyRound },
] as const;

/**
 * 平台运营方的管理项 —— 数据范围是所有企业账号。
 *
 * 账号管理排在前面:运营日常真正要做的是"谁在用、谁在烧钱、谁该停",
 * 而不是先看一张总量图表。
 */
export const ADMIN_NAV = [
  { href: "/admin/accounts", label: "账号管理", icon: Users },
  { href: "/admin/usage", label: "全平台用量", icon: BarChart3 },
] as const;

export type SettingsArea = "personal" | "admin";

/**
 * 两个【互不重叠】的区域。
 *
 * 【为什么不是一个侧栏里的两个分组】那样管理员无论从哪个入口进来,
 * 看到的都是同一份并排的清单 —— 分组标签只是给列表加了小标题,
 * "我现在在个人设置里"还是"在管理后台里"依旧无从判断。
 * 改成一次只显示一个区,顶部写清是哪个区;换区走头像菜单。
 */
const AREAS = {
  personal: {
    label: "账号设置",
    hint: "只影响本企业账号",
    icon: User,
    items: PERSONAL_NAV,
  },
  admin: {
    label: "平台管理",
    hint: "影响所有企业账号",
    icon: ShieldCheck,
    items: ADMIN_NAV,
  },
} as const;

/**
 * 设置区外壳。
 *
 * 【为什么不复用 AppShell】两者的侧栏内容是对立的:主区的侧栏是"去哪儿办事"
 * (工作台、会话),设置区的侧栏是"改哪项配置"。塞进同一个侧栏会让
 * 一条导航同时承担两种含义,项一多就谁也找不着。
 *
 * 进了设置区,侧栏整个换成设置导航,顶部给一条明确的回程 —— 这是
 * GitHub / Vercel / Linear 都在用的模式:设置是一个独立的地方,有去有回。
 */
export function SettingsShell({
  title,
  subtitle,
  actions,
  children,
  width = "wide",
  sidebarExtra,
  area = "personal",
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  width?: "narrow" | "wide";
  /** 页面级条目挂在设置导航下方(如构建器的智能体列表),避免再开第二条侧栏。 */
  sidebarExtra?: React.ReactNode;
  /** 当前页属于哪个区。一次只显示一个区的导航。 */
  area?: SettingsArea;
}) {
  const pathname = usePathname();
  const current = AREAS[area];

  const renderItems = (items: readonly { href: string; label: string; icon: typeof Bot }[]) => (
    <SidebarMenu>
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <SidebarMenuItem key={item.href}>
            <SidebarMenuButton
              asChild
              isActive={active}
              tooltip={item.label}
              className="relative data-[active=true]:bg-sidebar-active data-[active=true]:text-sidebar-active-foreground"
            >
              <Link href={item.href}>
                <span
                  className={cn(
                    "absolute left-0 top-1.5 bottom-1.5 w-0.5 origin-left rounded-r-full bg-brand transition-transform duration-200",
                    active ? "scale-x-100" : "scale-x-0",
                  )}
                />
                <item.icon className={cn(active ? "text-brand" : "text-muted-foreground/60")} />
                <span className="text-xs">{item.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );

  return (
    <SidebarProvider className="h-screen min-h-0">
      <Sidebar collapsible="icon">
        <SidebarHeader className="gap-2 border-b border-sidebar-border">
          {/*
            回程入口放在侧栏最上方、品牌的位置上。
            【为什么不是页头里的一个小箭头】设置区是个"进去就出不来"的地方 ——
            改造前从设置回工作台只能靠侧栏那条被淹没的导航项。回程要和
            "我在哪儿"处在同一个位置上,一眼能看到。
          */}
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md px-1 py-1 text-muted-foreground transition-colors hover:text-foreground group-data-[collapsible=icon]:px-0"
          >
            <ArrowLeft className="size-4 shrink-0" />
            <span className="truncate text-xs group-data-[collapsible=icon]:hidden">
              返回工作台
            </span>
          </Link>

          {/*
            当前在哪个区,写在最显眼的地方。
            【为什么管理区要用警示色】改的是全平台的东西,和只影响自己的个人设置
            不该长得一模一样 —— 颜色是这里唯一一眼可辨的差别。
          */}
          <div className="flex items-center gap-2 px-1 group-data-[collapsible=icon]:px-0">
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-md",
                area === "admin" ? "bg-[var(--warning)]/15" : "bg-brand/15",
              )}
            >
              <current.icon
                className={cn(
                  "size-3.5",
                  area === "admin" ? "text-[var(--warning)]" : "text-brand",
                )}
              />
            </span>
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="truncate text-sm font-semibold leading-tight">{current.label}</p>
              <p className="truncate text-[11px] leading-tight text-muted-foreground">
                {current.hint}
              </p>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          {/* 只显示当前区的导航 —— 分组标签没了,因为整个侧栏就是这一个区 */}
          <SidebarGroup>{renderItems(current.items)}</SidebarGroup>

          {/* 页面自己的条目(如构建器的智能体列表)紧跟其后 */}
          {sidebarExtra}
        </SidebarContent>

        <SidebarFooter className="border-t border-sidebar-border">
          {/*
            这里曾经有一条"前往另一个区"的按钮。去掉了 —— 头像菜单里
            「账号设置」和「平台管理」两个入口本来就都在,再放一条只是
            让同一个去处在一屏里出现两次。要换区从头像菜单走。
          */}
          <UserMenu />
        </SidebarFooter>

        <SidebarRail />
      </Sidebar>

      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-4" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold leading-tight">{title}</h1>
            {subtitle && (
              <p className="truncate text-xs leading-tight text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>

        <div className="min-h-0 flex-1 overflow-auto">
          <div
            className={cn("mx-auto space-y-6 p-6", width === "narrow" ? "max-w-3xl" : "max-w-4xl")}
          >
            {children}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
