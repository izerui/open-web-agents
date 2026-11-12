import type { Me } from "@/lib/use-me";
import {
  Activity,
  BarChart3,
  Coins,
  Cpu,
  KeyRound as Key,
  Lock,
  type LucideIcon,
  Package,
  ReceiptText,
  ScrollText,
  Store,
  Users,
  Wallet,
} from "lucide-react";

/*
 * 全站导航与路由的唯一来源(coze-v3 信息架构,见 docs/design-demos/coze-v3/information-architecture.md)。
 *
 * 【为什么集中】顶栏、侧栏、⌘K、旧地址重定向原先各自维护一份页面清单,改一处漏三处
 * —— 工作台的命令面板就曾缺了积分、套餐和管理页。现在都从这里取。
 *
 * 这个文件会被服务端页面(重定向)和客户端组件同时引用,所以只能依赖纯数据与类型,
 * 不能 import 带 "use client" 的模块里的函数。
 */

export type Space = "explore" | "chat" | "studio" | "developer" | "account" | "admin";

export const SPACES: readonly { key: Space; label: string; href: string; adminOnly?: boolean }[] = [
  { key: "explore", label: "探索", href: "/" },
  { key: "chat", label: "对话", href: "/chat" },
  { key: "studio", label: "工作室", href: "/agents" },
  { key: "developer", label: "开发者", href: "/developer/keys" },
  { key: "account", label: "账户", href: "/account/billing" },
  { key: "admin", label: "管理", href: "/admin/accounts", adminOnly: true },
];

export type SideItem = { href: string; label: string; icon: LucideIcon };
export type SideGroup = { group: string; items: readonly SideItem[] };

export const SIDE_NAV: Record<"developer" | "account" | "admin", readonly SideGroup[]> = {
  developer: [
    {
      group: "开发者",
      items: [
        { href: "/developer/keys", label: "API Key 与签名密钥", icon: Key },
        { href: "/developer/runs", label: "运行记录", icon: Activity },
      ],
    },
  ],
  account: [
    {
      group: "积分",
      items: [
        { href: "/account/billing", label: "积分与消耗", icon: Coins },
        { href: "/account/packages", label: "充值与订单", icon: Package },
        { href: "/account/usage", label: "用量分析", icon: BarChart3 },
        { href: "/account/prices", label: "模型价格", icon: ReceiptText },
      ],
    },
    {
      group: "账号",
      items: [
        { href: "/account/security", label: "账号安全", icon: Lock },
        { href: "/account/audit", label: "操作日志", icon: ScrollText },
      ],
    },
  ],
  // 阶段 7:平台管理合并为六项(原型 admin-*.html);旧管理页地址见 legacyRedirect
  admin: [
    {
      group: "平台管理",
      items: [
        { href: "/admin/accounts", label: "账号", icon: Users },
        { href: "/admin/models", label: "模型与提供者", icon: Cpu },
        { href: "/admin/market", label: "市场上架", icon: Store },
        { href: "/admin/packages", label: "套餐与订单", icon: Package },
        { href: "/admin/billing", label: "计费", icon: Wallet },
        { href: "/admin/ops", label: "平台运行与用量", icon: Activity },
      ],
    },
  ],
};

/** 与 use-me 的 isAdminView 同一规则;这里重写一遍是为了服务端也能用 */
function isAdmin(me: Me | null): boolean {
  if (!me) return false;
  return me.user ? me.user.role === "admin" : me.authRequired === false;
}

export function navFor(me: Me | null): typeof SPACES {
  return isAdmin(me) ? SPACES : SPACES.filter((s) => !s.adminOnly);
}

export function spaceOf(pathname: string): Space {
  if (pathname === "/chat" || pathname.startsWith("/chat/")) return "chat";
  if (pathname === "/agents" || pathname.startsWith("/agents/")) return "studio";
  if (pathname.startsWith("/developer")) return "developer";
  if (pathname.startsWith("/account")) return "account";
  if (pathname.startsWith("/admin")) return "admin";
  return "explore";
}

/** 平台运行三合一:旧的独立页面 → /admin/ops 的页签 */
const ADMIN_OPS_TAB: Record<string, string> = {
  "/admin/usage": "usage",
  "/admin/runs": "runs",
  "/admin/audit": "audit",
};

const SETTINGS_TO_ACCOUNT: Record<string, string> = {
  "/settings": "/account/security",
  "/settings/account": "/account/security",
  "/settings/credentials": "/account/prices",
  "/settings/billing": "/account/billing",
  "/settings/packages": "/account/packages",
  "/settings/usage": "/account/usage",
  "/usage": "/account/usage",
  "/settings/audit": "/account/audit",
};

function withQuery(path: string, q: URLSearchParams): string {
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * 旧地址 → 新地址(含查询串);不需要重定向时返回 null。
 * 书签、邮件、API 文档里的旧链接都还在外面,所以每条旧路由都要有去处。
 */
export function legacyRedirect(pathname: string, search: URLSearchParams): string | null {
  const q = new URLSearchParams(search);
  if (pathname === "/") return q.has("session") || q.has("agent") ? withQuery("/chat", q) : null;
  if (pathname === "/market") return withQuery("/", q);
  if (pathname === "/agents") {
    const id = q.get("id");
    if (id) {
      q.delete("id");
      return withQuery(`/agents/${encodeURIComponent(id)}`, q);
    }
    if (q.get("new") === "1") {
      q.delete("new");
      return withQuery("/agents/new", q);
    }
    return null;
  }
  if (pathname === "/settings/keys" || pathname === "/settings/runs") {
    const agent = q.get("agent");
    const stage = pathname === "/settings/keys" ? "access" : "runs";
    if (agent) {
      q.delete("agent");
      q.set("stage", stage);
      return withQuery(`/agents/${encodeURIComponent(agent)}`, q);
    }
    return withQuery(pathname.replace("/settings", "/developer"), q);
  }
  // 模型与提供者三合一:列表 → 页签,详情 → /admin/models/providers/<id>(?tab= 是详情页的类型页签,照带)
  if (pathname === "/admin/providers" || pathname === "/admin/capabilities") {
    if (!q.has("tab")) q.set("tab", "providers");
    return withQuery("/admin/models", q);
  }
  const provider = /^\/admin\/providers\/([^/]+)$/.exec(pathname);
  if (provider) return withQuery(`/admin/models/providers/${provider[1]}`, q);
  const opsTab = ADMIN_OPS_TAB[pathname];
  if (opsTab) {
    q.set("tab", opsTab);
    return withQuery("/admin/ops", q);
  }
  const account = SETTINGS_TO_ACCOUNT[pathname];
  return account ? withQuery(account, q) : null;
}

export type AgentStage = "eval" | "publish" | "access" | "runs";
export type AgentRoute = { kind: "list" } | { kind: "new" } | { kind: "agent"; id: string };

/** 构建页的地址:/agents(列表)、/agents/new(新建)、/agents/<id>(某个智能体) */
export function agentRoute(pathname: string): AgentRoute {
  const rest = pathname.replace(/^\/agents\/?/, "").split("/")[0] ?? "";
  if (!rest) return { kind: "list" };
  if (rest === "new") return { kind: "new" };
  try {
    return { kind: "agent", id: decodeURIComponent(rest) };
  } catch {
    return { kind: "agent", id: rest };
  }
}

export function agentHref(opts: { id?: string; isNew?: boolean; stage?: AgentStage } = {}): string {
  const path = opts.id
    ? `/agents/${encodeURIComponent(opts.id)}`
    : opts.isNew
      ? "/agents/new"
      : "/agents";
  return opts.stage ? `${path}?stage=${opts.stage}` : path;
}

export type MeMenuItem = { label: string; href?: string; action?: "logout" };

/** 头像菜单:身份相关的低频入口;平台管理在顶栏已有,这里给管理员留一个快捷入口 */
export function meMenuItems(me: Me | null): MeMenuItem[] {
  // 关闭登录的本地模式:接口返回 authenticated:false + authRequired:false,后端按匿名 admin 放行
  const local = me?.authRequired === false;
  if (me && !me.authenticated && !local) return [{ label: "去登录", href: "/login" }];
  const items: MeMenuItem[] = [
    { label: "积分与套餐", href: "/account/billing" },
    { label: "账号安全", href: "/account/security" },
    { label: "操作日志", href: "/account/audit" },
  ];
  if (isAdmin(me)) items.push({ label: "平台管理", href: "/admin/accounts" });
  // 本地模式登出没有意义;登录态还没读到(或读取失败)时也不给登出,免得和身份信息自相矛盾
  if (me?.authenticated && !local) items.push({ label: "登出", action: "logout" });
  return items;
}

export type PaletteEntry = { group: string; label: string; href: string; keywords: string };

/**
 * ⌘K 里的页面:各侧栏页面、新建智能体、一级空间;按角色过滤,地址去重。
 * 同一地址既是空间入口又是侧栏第一项时(开发者 = API Key 页),保留更具体的侧栏名,
 * 空间名并进 keywords —— 两个名字都搜得到。
 */
export function paletteEntries(me: Me | null): PaletteEntry[] {
  const admin = isAdmin(me);
  const spaces = navFor(me);
  const entries: PaletteEntry[] = [];
  for (const [kind, groups] of Object.entries(SIDE_NAV)) {
    if (kind === "admin" && !admin) continue;
    for (const g of groups) {
      for (const item of g.items) {
        entries.push({ group: g.group, label: item.label, href: item.href, keywords: g.group });
      }
    }
  }
  entries.push({ group: "操作", label: "新建智能体", href: "/agents/new", keywords: "工作室" });
  for (const s of spaces) {
    const same = entries.find((e) => e.href === s.href);
    if (same) same.keywords = `${same.keywords} ${s.label}`;
    else entries.push({ group: "空间", label: s.label, href: s.href, keywords: "" });
  }
  // 空间排在最前:没输入时先看到的是去哪个区
  return [
    ...entries.filter((e) => e.group === "空间"),
    ...entries.filter((e) => e.group !== "空间"),
  ];
}
