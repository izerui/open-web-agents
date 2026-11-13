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
        // 充值与订单是「积分与套餐」的一个页签(/account/billing?tab=packages),不再单列
        { href: "/account/billing", label: "积分与套餐", icon: Coins },
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

/**
 * 有没有积分账户与密码。关闭登录的本地模式由后端发一个匿名管理员,它不在账号表里:
 * 积分页读出来是「账号不存在」,改密码也无从谈起。还没读到登录态时先按有处理。
 */
export function hasCreditsAccount(me: Me | null): boolean {
  return !(me && me.authRequired === false && !me.user);
}

/** 本地模式下不该出现的入口(积分页、账号安全) */
const NO_ACCOUNT_HREFS = new Set(["/account/billing", "/account/security"]);

export function navFor(me: Me | null): typeof SPACES {
  const spaces = isAdmin(me) ? SPACES : SPACES.filter((s) => !s.adminOnly);
  if (hasCreditsAccount(me)) return spaces;
  // 「账户」默认进积分与套餐;本地模式没有积分账户,改进用量分析
  return spaces.map((s) => (s.key === "account" ? { ...s, href: "/account/usage" } : s));
}

/** 某个空间的侧栏(本地模式去掉积分与套餐、账号安全;去空后不留空分组) */
export function sideNavFor(kind: keyof typeof SIDE_NAV, me: Me | null): readonly SideGroup[] {
  if (hasCreditsAccount(me)) return SIDE_NAV[kind];
  return SIDE_NAV[kind]
    .map((g) => ({ ...g, items: g.items.filter((i) => !NO_ACCOUNT_HREFS.has(i.href)) }))
    .filter((g) => g.items.length > 0);
}

export function spaceOf(pathname: string): Space {
  if (pathname === "/chat" || pathname.startsWith("/chat/")) return "chat";
  if (pathname === "/agents" || pathname.startsWith("/agents/")) return "studio";
  if (pathname.startsWith("/developer")) return "developer";
  // 「我的」聚合页是手机入口;桌面上打开时归到账户空间(有账户侧栏可去各页)
  if (pathname.startsWith("/account") || pathname === "/me") return "account";
  if (pathname.startsWith("/admin")) return "admin";
  return "explore";
}

export type MobileTab = "explore" | "chat" | "studio" | "me";

/**
 * 手机(窄屏)底部标签栏(取舍 11,原型 mobile.html)。只在窄屏显示,不进桌面一级导航。
 * 「我的」是聚合页 /me:积分、订单、账号相关的入口都从这里进。
 */
export const MOBILE_TABS: readonly { key: MobileTab; label: string; href: string }[] = [
  { key: "explore", label: "探索", href: "/" },
  { key: "chat", label: "对话", href: "/chat" },
  { key: "studio", label: "工作室", href: "/agents" },
  { key: "me", label: "我的", href: "/me" },
];

/**
 * 哪些页面显示底部标签栏。对话页(底部是输入框)和设计器会话页是全屏的工作区,
 * 原型里也不带标签栏;其余页面都带。
 */
export function mobileTabsVisible(pathname: string): boolean {
  if (pathname === "/chat" || pathname.startsWith("/chat/")) return false;
  if (pathname === "/agents/design" || pathname.startsWith("/agents/design/")) return false;
  return pathname !== "/login";
}

/** 当前页高亮哪个标签:开发者、账户、管理都从「我的」进,算在它下面 */
export function mobileTabOf(pathname: string): MobileTab {
  const space = spaceOf(pathname);
  if (space === "chat" || space === "studio" || space === "explore") return space;
  return "me";
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
  "/settings/packages": "/account/billing?tab=packages",
  "/account/packages": "/account/billing?tab=packages",
  "/settings/usage": "/account/usage",
  "/usage": "/account/usage",
  "/settings/audit": "/account/audit",
};

function withQuery(path: string, q: URLSearchParams): string {
  // 目标自带查询(如 ?tab=packages)时与旧地址的参数合并,目标里的值优先
  const [base = path, own] = path.split("?");
  const merged = new URLSearchParams(q);
  for (const [k, v] of new URLSearchParams(own ?? "")) merged.set(k, v);
  const s = merged.toString();
  return s ? `${base}?${s}` : base;
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
      // 旧 Builder 的分区页签换成构建页的阶段
      const tab = q.get("tab");
      if (tab !== null) {
        const stage = stageOfLegacyTab(tab);
        if (stage !== undefined) {
          q.delete("tab");
          if (stage) q.set("stage", stage);
        }
      }
      return withQuery(`/agents/${encodeURIComponent(id)}`, q);
    }
    if (q.get("new") === "1") {
      q.delete("new");
      return withQuery("/agents/new", q);
    }
    return null;
  }
  if (
    pathname === "/settings/keys" ||
    pathname === "/settings/runs" ||
    pathname === "/developer/keys" ||
    pathname === "/developer/runs"
  ) {
    // 单个智能体的接入与运行在它的构建页;开发者空间只放账号级的 Key 与全部运行
    const agent = q.get("agent");
    const stage = pathname.endsWith("/keys") ? "access" : "runs";
    if (agent) {
      q.delete("agent");
      q.set("stage", stage);
      return withQuery(`/agents/${encodeURIComponent(agent)}`, q);
    }
    if (pathname.startsWith("/developer")) return null;
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

export function agentHref(
  opts: { id?: string; isNew?: boolean; stage?: AgentStage; designer?: string } = {},
): string {
  const path = opts.id
    ? `/agents/${encodeURIComponent(opts.id)}`
    : opts.isNew
      ? "/agents/new"
      : "/agents";
  const q = new URLSearchParams();
  if (opts.stage) q.set("stage", opts.stage);
  if (opts.designer) q.set("designer", opts.designer);
  const s = q.toString().replace(/\+/g, "%20");
  return s ? `${path}?${s}` : path;
}

/**
 * 旧 Builder(/agents?id=x&tab=…)的分区页签 → 构建页阶段。
 * 评测、发布各有阶段;配置、能力、知识、安全与契约都在编排里(null = 编排,去掉 stage);
 * 不认识的页签(如接入中心的 keys / docs / webhook)返回 undefined,阶段不变。
 */
export function stageOfLegacyTab(tab: string): AgentStage | null | undefined {
  if (tab === "eval") return "eval";
  if (tab === "release") return "publish";
  if (["config", "capabilities", "knowledge", "security"].includes(tab)) return null;
  return undefined;
}

export type MeMenuItem = { label: string; href?: string; action?: "logout" };

/** 头像菜单:身份相关的低频入口;平台管理在顶栏已有,这里给管理员留一个快捷入口 */
export function meMenuItems(
  me: Me | null,
  /** credits:false = 读不到积分账户,隐藏积分入口;没给 = 照常显示(本地模式另由 hasCreditsAccount 判定) */
  opts: { credits?: boolean } = {},
): MeMenuItem[] {
  // 关闭登录的本地模式:接口返回 authenticated:false + authRequired:false,后端按匿名 admin 放行
  const local = me?.authRequired === false;
  if (me && !me.authenticated && !local) return [{ label: "去登录", href: "/login" }];
  const account = hasCreditsAccount(me);
  const items: MeMenuItem[] = [
    ...(opts.credits === false || !account
      ? []
      : [{ label: "积分与套餐", href: "/account/billing" }]),
    // 本地模式没有密码,改密码表单用不了
    ...(account ? [{ label: "账号安全", href: "/account/security" }] : []),
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
  for (const kind of Object.keys(SIDE_NAV) as (keyof typeof SIDE_NAV)[]) {
    if (kind === "admin" && !admin) continue;
    for (const g of sideNavFor(kind, me)) {
      for (const item of g.items) {
        entries.push({ group: g.group, label: item.label, href: item.href, keywords: g.group });
      }
    }
  }
  entries.push({ group: "操作", label: "新建智能体", href: "/agents/new", keywords: "工作室" });
  // 对话页不带会话 = 新会话;带个 new 参数和「对话」空间入口区分开(地址去重时不合并)
  entries.push({ group: "操作", label: "新会话", href: "/chat?new=1", keywords: "对话 新建" });
  for (const s of spaces) {
    const same = entries.find((e) => e.href === s.href);
    if (same) same.keywords = `${same.keywords} ${s.label}`;
    else entries.push({ group: "空间", label: s.label, href: s.href, keywords: "" });
  }
  // 与原型一致:没输入时先看到「操作」(新建智能体、新会话),再是去哪个区
  const order = (g: string) => (g === "操作" ? 0 : g === "空间" ? 1 : 2);
  return entries
    .map((e, i) => [e, i] as const)
    .sort(([a, i], [b, j]) => order(a.group) - order(b.group) || i - j)
    .map(([e]) => e);
}
