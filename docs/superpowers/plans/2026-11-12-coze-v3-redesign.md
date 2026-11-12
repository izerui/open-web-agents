# coze-v3「对话搭建」改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Open Web Agents 的前端整体改成用户选定的 dir-2「对话搭建」设计（暖纸浅色、智能体设计器为主角、构建页五阶段），并补上 gaps.md 的 A1–A17 新功能。

**Architecture:** 分 8 个阶段，每阶段单独可上线、可验证。阶段 1 只换「地基」：设计令牌、基础组件、眼睛头像、新外壳（顶栏＋账号菜单＋⌘K＋侧栏）、新路由与旧地址重定向；所有现有页面套上新外壳，功能不变。阶段 2–7 逐个区域按原型重做页面，后端新功能跟着所属页面进入对应阶段。阶段 8 做移动端收尾与全量 E2E。本文件对阶段 1 给出逐任务细节；阶段 2–8 列出范围与验收，开工前各自补一份同格式的详细计划（追加在本文件末尾）。

**Tech Stack:** Next.js 16（App Router）、React、Tailwind v4（`@theme inline`）、shadcn new-york 组件、biome、vitest、playwright、mysql2 / drizzle。

**Spec:** `docs/design-demos/coze-v3/` —— `prototype/`（21 页可点原型，`prototype/index.html` 为目录）、`information-architecture.md`（一级空间、构建页五阶段、旧路由映射）、`features.md`（现有功能全清单）、`gaps.md`（A1–A17 新功能，用户已决定全部补上）、`direction-approved.md`（用户原话）。

## Global Constraints

- 视觉以 `prototype/assets/owa.css` 为准：底 `#F7F6F2`、卡片 `#FFFFFF`、分割线 `#E6E3DB` / `#EFECE5`、正文 `#1B1B1A`、次要 `#6B6860`、主按钮近黑 `#1C1C1C` 胶囊、完成色 `#3F7A57`（浅底 `#E8EFE9`，标签文字 `#2F6345`）、提醒 `#B7791F`（文字 `#85570F`，浅底 `#FBF1DE`）、危险 `#B4442F`（浅底 `#F8E7E2`）；卡片圆角 16–18px、控件 10px、按钮胶囊
- 大标题与智能体名用衬线：`"Noto Serif SC","Songti SC","STSong",serif`（不从 Google Fonts 下载，构建不得联网；本地已有字体保持 `next/font/local`）
- 可读性底线：正文 ≥14px（移动端 16px）、标签 ≥12px、正文对比度 ≥4.5:1、移动端可点元素 ≥44×44
- 只有浅色主题；去掉 `<html class="dark">`
- 统一称谓：「智能体设计器」（由 agent-architect 驱动），不再用「AI 编辑」「搭建助手」
- 不加模板装饰：标题上方全大写小标签、按钮尾巴「→」、「A · B · C」中点连接、无序内容编号
- 用户确认的产品规则不能画错：发布要求对当前草稿评测全部通过；回滚 / 设为发布版不受评测限制；公开 ≠ 上架；Key 明文只显示一次；会话私有（管理员也不能看）
- 每个阶段结束必须全绿：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`，并用浏览器逐页截图核对原型
- 未经用户同意不提交（commit 步骤在执行时先问）

## Review Focus

- 旧链接仍然有效：书签、邮件、API 文档里的 `/?session=`、`/agents?id=`、`/settings/keys?agent=`、`/agents/design?session=` 打开后落到新位置且保留参数 —— 测试见 Task 4 `legacyRedirect` 用例表
- 普通账号看不到「管理」入口，直接打开 `/admin/*` 仍被服务端挡回 —— 见 Task 5 `navFor` 用例与现有 `requireAdmin`
- 关闭登录的本地模式（匿名 admin）下外壳不报错、不显示「登出」 —— 见 Task 5 `MeMenu` 用例
- 窄屏（375 宽）顶栏不溢出，导航收进抽屉 —— 见 Task 6 截图核对
- 颜色令牌改动后对比度不退化 —— 见 Task 1 `tokens.test.ts`

---

## 阶段总览

| 阶段 | 内容 | 新功能（gaps.md） | 验收 |
| --- | --- | --- | --- |
| 1 地基 | 令牌、组件、头像、外壳、路由与重定向 | A12（头像） | 全部旧页面在新外壳里可用；旧地址全部重定向 |
| 2 探索与市场 | `/` 探索首页、`/market/[id]` 详情、登录页 | A1 意图推荐、A2 正在工作、A10 作者与使用次数、A11 每次约花费 | 对照 explore / market-detail / login 原型 |
| 3 对话 | `/chat` 会话列表（含归档恢复）、对话头、提问卡片、审批条、工作区文件、执行详情 | — | 对照 chat 原型全部状态 |
| 4 工作室 | `/agents` 我的智能体、新建弹层（设计器 / 空白 / 克隆 / 模板库） | A14 模板库 | 对照 studio 原型 |
| 5 构建页 | `/agents/[id]` 五阶段；智能体设计器承接 `/agents/design` 全部能力；档案卡全部字段 | A3 自动保存、A4 按节应用、A5 试聊、A6 存为用例、A7 让设计器修复、A8 上线清单、A9 评测花费预估、A13 申请上架、A15 按组分享、A16 在线试调、A17 单智能体统计 | 主流程从新建点到接入；对照 build 原型全部状态 |
| 6 开发者与账户 | `/developer/*`、`/account/*` | — | 对照 dev-* / account-* 原型 |
| 7 平台管理 | 账号（含用户组）、模型与提供者三合一、市场上架（含申请审核）、套餐、计费、平台运行三合一 | A13 审核端、A15 用户组管理 | 对照 admin-* 原型 |
| 8 收尾 | 移动端（375）全站适配、E2E 全量、文档 | — | `pnpm test:e2e` 全绿；375 宽逐页截图 |

---

## 阶段 1：地基

### 新路由表（阶段 1 定死，后续阶段只换页面内容）

| 新地址 | 阶段 1 渲染 | 旧地址（重定向到新地址，保留其余查询参数） |
| --- | --- | --- |
| `/` | `MarketView`（阶段 2 换成探索页） | — |
| `/chat` | `Workbench`（原 `/` 的服务端逻辑整体搬过来） | `/?session=…`、`/?agent=…` |
| `/agents` | `Builder`（列表） | — |
| `/agents/[id]` | `Builder`（编辑该 id；阶段 5 换成构建页） | `/agents?id=x` → `/agents/x` |
| `/agents/[id]?stage=eval\|publish\|access\|runs` | 同上（阶段 5 生效） | `/settings/keys?agent=x` → `/agents/x?stage=access`；`/settings/runs?agent=x` → `/agents/x?stage=runs` |
| `/agents/[id]?designer=<sessionId>` | 阶段 1 继续用 `DesignWorkspace`（见 Task 4） | `/agents/design?session=s` → 服务端查设计会话的 targetId，有则 `/agents/<targetId>?designer=s`，没有则 `/agents/new?designer=s` |
| `/agents/new` | `Builder` 新建态 | `/agents?new=1` |
| `/market/[id]` | `MarketDetail` | `/market` → `/` |
| `/developer/keys`、`/developer/runs` | `AccessCenterView`、`RunsView` | `/settings/keys`、`/settings/runs` |
| `/account/billing`、`/account/packages`、`/account/usage`、`/account/prices`、`/account/security`、`/account/audit` | 对应现有视图 | `/settings/billing`、`/settings/packages`、`/settings/usage`、`/settings/credentials`、`/settings/account`、`/settings/audit`、`/settings`、`/usage` |
| `/admin/*` | 地址不变（阶段 7 合并时再加重定向） | — |

### 文件结构

- `src/app/globals.css` —— 令牌整体替换为暖纸浅色（Task 1）
- `src/app/__tests__/tokens.test.ts` —— 令牌对比度测试（Task 1）
- `src/components/ui/{button,badge,input,textarea,select,native-select,card,tabs,dialog,sheet,dropdown-menu,command,tooltip}.tsx` —— 样式改造（Task 2）
- `src/lib/agent-avatar.ts`、`src/lib/__tests__/agent-avatar.test.ts`、`src/components/agent-avatar.tsx` —— 眼睛头像（Task 3）
- `src/lib/nav/routes.ts`、`src/lib/nav/__tests__/routes.test.ts` —— 唯一的导航与路由定义、旧地址映射（Task 4）
- `src/app/**/page.tsx` —— 新路由页与重定向页（Task 4）
- `src/components/shell/{app-shell,top-nav,me-menu,command-palette,side-nav}.tsx` —— 新外壳（Task 5）
- `src/components/space-shell.tsx`、`src/components/ide/ide-frame.tsx` —— 改为新外壳上的薄包装，阶段 3/5 后删除（Task 5）
- 删除：`src/components/ide/status-bar.tsx`（无引用）、`agent-tree.tsx`、`tool-list.tsx` 中仅被旧外壳使用的部分（Task 5 末尾按引用核对后删）
- `playwright/*.spec.ts` —— 更新地址（Task 6）

### Task 1: 设计令牌（暖纸浅色）

**Files:**
- Modify: `src/app/globals.css`（`@theme inline`、`:root`、删除 `.dark` 块、base layer）
- Modify: `src/app/layout.tsx`（去掉 `dark` 类，加 `--font-display`）
- Create: `src/app/__tests__/tokens.test.ts`

**Interfaces:**
- Produces: Tailwind 颜色 `background card popover foreground muted-foreground primary(#1C1C1C) secondary accent border input ring success warning destructive info brand` 及新增 `success-soft warning-soft destructive-soft success-text warning-text line-soft band fresh`；字体工具类 `font-display`；`--text-sm` 恢复 0.875rem（14px）；`--radius` 0.625rem（10px）；`rounded-2xl` = 16px、`rounded-3xl` = 18px；`--shadow-popup: 0 14px 40px rgb(40 35 25 / 14%)`

- [ ] **Step 1: 写失败的测试** —— `tokens.test.ts` 读 `globals.css` 文本，解析 `:root` 中的 hex 变量，断言：
  - `contrast(--foreground, --background) >= 7`
  - `contrast(--muted-foreground, --background) >= 4.5`、`contrast(--muted-foreground, --card) >= 4.5`
  - `contrast(--success-text, --success-soft) >= 4.5`、`contrast(--warning-text, --warning-soft) >= 4.5`、`contrast(--destructive, --destructive-soft) >= 4.5`
  - `contrast(--primary-foreground, --primary) >= 7`
  - 文件中不再出现 `.dark {`
- [ ] **Step 2:** `pnpm vitest run src/app/__tests__/tokens.test.ts` → FAIL（变量缺失 / `.dark` 仍在）
- [ ] **Step 3: 改 `globals.css`** —— 值取自 Global Constraints；`sidebar-*` 系列映射到 `background / card / border`，`sidebar-active` = `#FFFFFF`（选中为白底细边，与原型 `.side a.on` 一致）；`ide-cyan / ide-purple` 改为 `#2F6F79` / `#7A4F8C`（工具名区分色，深一档保证对比度）；滚动条拇指改 `rgb(107 104 96 / 30%)`；`body` 字号 14px；`.chat-md` 保留并把行内代码底色改 `#F1EFEA`
- [ ] **Step 4: 改 `layout.tsx`** —— `className` 去掉 `dark`；`globals.css` 中 `--font-display` 定义为衬线字体栈（不新增 Google 字体）
- [ ] **Step 5:** 测试通过；`pnpm typecheck && pnpm lint`
- [ ] **Step 6: Commit（先问用户）** `style: 改用暖纸浅色设计令牌`

### Task 2: 基础组件改样式

**Files:** Modify `src/components/ui/` 下 button、badge、input、textarea、select、native-select、card、tabs、dialog、sheet、dropdown-menu、command、tooltip

**Interfaces:**
- Produces:
  - `Button` 变体：`default`（近黑胶囊 `rounded-full`）、`outline`（白底细边胶囊）、`secondary`、`ghost`、`destructive`（白底红字红边）、`success`（灰绿实心）、`link`；尺寸 `default h-10 px-[18px]`、`sm h-8 px-3.5`、`xs h-7`、`lg h-11`、`icon size-10`、`icon-sm size-8`；禁用：底 `#E3E0D8`、字 `#57544D`
  - `Badge` 变体：`default`（`#EFEDE7` 底）、`success`、`warning`、`destructive`、`dark`、`outline`（透明底细边）—— 胶囊 `h-[22px] text-xs`
  - `Tabs` 新增 `variant="segment"`（灰底胶囊分段，原型 `.seg`），保留 `line`
  - `Card` `rounded-2xl border bg-card`，无阴影
  - `Dialog` `rounded-[18px] p-7`，标题 `font-display text-[22px]`；`Sheet` 右侧抽屉白底左细线
  - 输入类 `h-[38px] rounded-[10px]`，focus 边框 `#9C978B` + `ring-[3px] ring-[#ECE9E1]`

- [ ] **Step 1:** 改上述组件的 cva 类名（不改 props 签名，保证现有调用不破）
- [ ] **Step 2:** `pnpm typecheck && pnpm lint && pnpm test` 全绿
- [ ] **Step 3:** `pnpm dev`，浏览器打开 `/settings/account`、`/settings/keys`、`/admin/accounts`，截图核对按钮、输入、标签、弹窗与 `prototype/shots/account-billing.png`、`admin-accounts-drawer.png` 一致
- [ ] **Step 4: Commit（先问用户）** `style: 基础组件改为对话搭建风格`

### Task 3: 智能体眼睛头像（A12）

**Files:**
- Create: `src/lib/agent-avatar.ts`、`src/lib/__tests__/agent-avatar.test.ts`、`src/components/agent-avatar.tsx`

**Interfaces:**
- Produces:
  - `type AvatarEyes = "pill" | "round" | "side" | "dot" | "white"`
  - `type AvatarStyle = { color: string; eyes: AvatarEyes }`
  - `AVATAR_COLORS: readonly string[]` = `["#F2B49B","#C8C2E8","#E7D2AA","#CADBCF","#B9D0E8","#F4B3C3","#E3C59D","#C9DDBD","#DAD3C4","#B8DCD6","#F0D58C"]`
  - `avatarStyle(id: string, icon?: string | null): AvatarStyle` —— `icon` 形如 `"avatar:#F2B49B:pill"` 时按它，否则按 id 的稳定哈希取色与眼睛（`white` 只给 `agent-architect`，底色 `#1F1E1C`）
  - `formatAvatarIcon(style: AvatarStyle): string`（写回配置的 `icon` 字段）
  - `<AgentAvatar id={string} icon?={string|null} size?={number} className? />`（内联 SVG，40 栅格，与原型 `av()` 相同几何）

- [ ] **Step 1: 测试**：同一 id 两次结果相同；不同 id 至少覆盖 3 种颜色（取 20 个 id）；`avatarStyle("x", "avatar:#C8C2E8:round")` → `{color:"#C8C2E8",eyes:"round"}`；非法 icon（`"🙂"`、`"avatar:red:pill"`）回落到哈希；`agent-architect` → `{color:"#1F1E1C",eyes:"white"}`；`formatAvatarIcon` 与 `avatarStyle` 往返一致
- [ ] **Step 2:** 跑测试 → FAIL
- [ ] **Step 3:** 实现 `agent-avatar.ts` 与组件
- [ ] **Step 4:** 测试通过
- [ ] **Step 5: Commit（先问用户）** `feat: 智能体眼睛头像`

### Task 4: 导航与路由单一来源、新路由与旧地址重定向

**Files:**
- Create: `src/lib/nav/routes.ts`、`src/lib/nav/__tests__/routes.test.ts`
- Create pages: `src/app/chat/page.tsx`、`src/app/agents/[id]/page.tsx`、`src/app/agents/new/page.tsx`、`src/app/developer/keys/page.tsx`、`src/app/developer/runs/page.tsx`、`src/app/account/{billing,packages,usage,prices,security,audit}/page.tsx`
- Modify pages（变成重定向）：`src/app/page.tsx`（带 session/agent 参数时重定向，否则渲染 `MarketView`）、`src/app/market/page.tsx`、`src/app/agents/design/page.tsx`、`src/app/settings/**/page.tsx`、`src/app/usage/page.tsx`
- Modify: `src/features/builder/builder.tsx`（接收 `agentId` / `isNew` props，替代读取 `?id` / `?new`）、全仓库硬编码旧地址的 `href` / `router.push`（`grep -rn '"/?session\|/agents?id=\|/settings/' src`）

**Interfaces:**
- Produces:
  - `type Space = "explore" | "chat" | "studio" | "developer" | "account" | "admin"`
  - `SPACES: readonly { key: Space; label: string; href: string; adminOnly?: boolean }[]` = 探索 `/`、对话 `/chat`、工作室 `/agents`、开发者 `/developer/keys`、账户 `/account/billing`、管理 `/admin/accounts`（adminOnly）
  - `SIDE_NAV: Record<"developer"|"account"|"admin", readonly { group: string; items: readonly { href: string; label: string; icon: LucideIcon }[] }[]>`（内容照原型 `SIDES`；管理项阶段 1 仍列现有 9 个 admin 页）
  - `spaceOf(pathname: string): Space`
  - `navFor(me: Me | null): typeof SPACES`（非 admin 去掉 adminOnly）
  - `legacyRedirect(pathname: string, search: URLSearchParams): string | null`（返回目标「路径+查询」，无需重定向返回 null）
  - `paletteEntries(me: Me | null): { group: "页面"; label: string; href: string; keywords: string }[]`

- [ ] **Step 1: 测试 `legacyRedirect`**（用例表，逐条断言）：
  - `/`, `session=s1` → `/chat?session=s1`；`/`, `agent=a&session=s` → `/chat?agent=a&session=s`；`/`, 空 → `null`
  - `/agents`, `id=x` → `/agents/x`；`/agents`, `id=x&tab=eval` → `/agents/x?tab=eval`；`/agents`, `new=1` → `/agents/new`
  - `/settings/keys`, `agent=x` → `/agents/x?stage=access`；`/settings/keys`, 空 → `/developer/keys`
  - `/settings/runs`, `agent=x` → `/agents/x?stage=runs`；`/settings/runs` → `/developer/runs`
  - `/settings` → `/account/security`；`/settings/account` → `/account/security`；`/settings/credentials` → `/account/prices`；`/settings/billing` → `/account/billing`；`/settings/packages` → `/account/packages`；`/settings/usage`、`/usage` → `/account/usage`；`/settings/audit` → `/account/audit`
  - `/market` → `/`；`/market/x` → `null`
  - 参数值含 `&`、中文时编码正确（`session=a%26b`）
- [ ] **Step 2: 测试 `navFor` / `spaceOf`**：user 不含 admin、admin 含；`spaceOf("/agents/x")` = studio、`/developer/runs` = developer、`/admin/models` = admin、`/market/x` = explore、`/` = explore、`/chat` = chat
- [ ] **Step 3:** 跑测试 → FAIL；实现 `routes.ts`；测试通过
- [ ] **Step 4: 建新页面与重定向页** —— 每个旧页面 `redirect(legacyRedirect(...) ?? fallback)`（保持 `force-dynamic` 与 `requireLogin/requireAdmin` 守卫在新页面上）；`/agents/design` 页在服务端用 `getContainer().designer.inspect(subject, sessionId)` 取 `targetId` 再重定向（`subject` 取法同 `src/app/api/agents/design/_lib` 的 `designCaller`；查不到或无权限时落到 `/agents/new?designer=<id>`，由页面显示现有错误态）；`/agents/[id]` 阶段 1 若带 `designer` 参数则渲染 `DesignWorkspace initialSessionId`，否则 `Builder agentId`
- [ ] **Step 5:** 替换仓库内旧地址链接（`grep` 结果逐个改为新地址；`agent-tree.tsx` 里按 tab 跳转的逻辑一并改）；`pnpm typecheck && pnpm lint && pnpm test`
- [ ] **Step 6:** 浏览器逐个打开旧地址，确认落点与参数（截一张列表留证）
- [ ] **Step 7: Commit（先问用户）** `feat: 新信息架构路由与旧地址重定向`

### Task 5: 新外壳 AppShell

**Files:**
- Create: `src/components/shell/app-shell.tsx`、`top-nav.tsx`、`me-menu.tsx`、`command-palette.tsx`、`side-nav.tsx`、`src/components/shell/__tests__/me-menu.test.tsx`（若仓库没有 React 组件测试环境，改为把菜单项计算抽成 `meMenuItems(me)` 纯函数放 `src/lib/nav/routes.ts` 测试）
- Modify: `src/components/space-shell.tsx`（内部改用 `AppShell`，保留现有 props；`area` 决定侧栏：personal→account、admin→admin、agents/market→无侧栏；`object` 头部阶段 1 继续渲染 `AgentWorkspaceHeader`）
- Modify: `src/components/ide/ide-frame.tsx`（改为 `AppShell` 包装：`toolWindow` 渲染为左侧 264px 白底栏，`object` 头部照旧，`onSearchAction` 透传给顶栏搜索按钮）
- Delete: `src/components/ide/status-bar.tsx`（无引用，features.md 已确认）

**Interfaces:**
- Consumes: `SPACES / navFor / spaceOf / SIDE_NAV / paletteEntries`（Task 4）、`useMe`、`AgentAvatar`（Task 3）
- Produces:
  - `<AppShell side?={"developer"|"account"|"admin"} onSearchAction?={() => void} fullBleed?={boolean}>{children}</AppShell>` —— 顶栏 60px（品牌、空间导航、⌘K 搜索按钮、积分胶囊链到 `/account/billing`、账号头像菜单）；`side` 存在时左侧 220px 侧栏；`fullBleed` 时主区不加内边距、不滚动（工作台、构建页自己管滚动）；`<md` 宽时空间导航收进左侧抽屉
  - `meMenuItems(me): { label: string; href?: string; action?: "logout" }[]` —— 积分与套餐、账号安全、操作日志、（admin）平台管理、登出（`authRequired === false` 时不出现登出）
  - 积分胶囊数据：`GET /api/billing?limit=1` 的可用余额（沿用 `status-bar.tsx` 里的读取方式，失败时不显示数字）

- [ ] **Step 1: 测试 `meMenuItems`**：普通账号 5 项不含平台管理；admin 含平台管理；`authRequired:false` 不含登出；未登录返回「去登录」一项
- [ ] **Step 2:** 跑测试 → FAIL；实现；测试通过
- [ ] **Step 3:** 实现外壳组件（样式照 `owa.css` 的 `.topnav .navs .credit .me .side .menu #palette`）；⌘K 打开 `command-palette`（页面 + 我的智能体 + 最近会话，数据来自现有 `/api/agents`、`/api/sessions`），工作台传 `onSearchAction` 时用它自己的面板
- [ ] **Step 4:** 改 `space-shell.tsx`、`ide-frame.tsx`；删除 `status-bar.tsx`
- [ ] **Step 5:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
- [ ] **Step 6: Commit（先问用户）** `feat: 对话搭建风格的全站外壳`

### Task 6: 阶段 1 验收

**Files:** Modify `playwright/*.spec.ts`（地址改新路由：`/agents?id=review-a` → `/agents/review-a`，`/?session=` → `/chat?session=`，`/settings/*` → 新地址；断言里依赖旧外壳 DOM 的选择器改为按角色 / 文案定位）

- [ ] **Step 1:** 更新 playwright 用例地址与选择器
- [ ] **Step 2:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿
- [ ] **Step 3:** `pnpm dev` 后逐个打开下列地址，1440 与 375 两个宽度截图存 `docs/design-demos/coze-v3/implementation/phase-1/`：`/`、`/chat`、`/agents`、`/agents/<任一 id>`、`/agents/new`、`/developer/keys`、`/developer/runs`、`/account/billing`、`/account/usage`、`/account/prices`、`/account/security`、`/account/audit`、`/admin/accounts`、`/admin/providers`、`/login`；确认：无控制台错误、顶栏与侧栏与原型一致、375 宽不横向溢出
- [ ] **Step 4:** 如有测试库，`pnpm test:e2e` 跑 playwright；没有则在交付说明写明未跑
- [ ] **Step 5:** 向用户汇报阶段 1 结果与截图，确认后进入阶段 2

---

## 阶段 2–8 范围（开工前补详细任务）

**阶段 2 探索与市场**：`src/features/explore/`（新）。首页大输入框：后端 `GET /api/market/suggest?q=` 按名称、说明、示例问题、类别做关键词打分返回前 3 个已上架智能体（A1 第一版，不调模型），首选项永远是「让智能体设计器做一个」→ `/agents/new?desc=`；「你的 AI 同事正在工作」取最近 5 个会话 + 最近一次运行状态 + 工作区最新文件（A2，新接口 `GET /api/sessions/recent`）；市场卡片作者 = 所有者邮箱前缀 / 显示名、使用次数 = 近 90 天运行数（A10，`market` 列表接口加字段，按日汇总缓存）、「约 N 积分/次」= 近 50 次成功运行平均实扣，无数据显示模型单价（A11）。登录页照原型。

**阶段 3 对话**：`/chat` 照 chat 原型重排 workbench；会话列表「已归档」视图（`PATCH archived=false`）；设计器会话标「设计器」并跳构建页；去掉旧对象树与对象头。

**阶段 4 工作室**：`/agents` 卡片 / 列表、页签我建的 / 分享给我的 / 全部；新建弹层四种方式；模板库为代码内静态目录 `src/lib/modules/agent/templates.ts`（A14，6 个模板），选中后用模板创建草稿并进入构建页。

**阶段 5 构建页**：`src/features/build/`（新，替代 `builder.tsx` 与 `design-workspace.tsx`）。草稿自动保存（A3：字段停顿 800ms 后 PUT，表单不认识的字段原样保留，与现有保存逻辑同一函数；名称或提示词为空、Schema 非法时暂停并在页头说明）；新建即建草稿（去掉「先保存」闸门）；左栏智能体设计器承接 design-workspace 全部能力并新增按节应用（A4）；右栏档案 / 试聊（A5，复用工作台对话组件，会话 source 标试运行）；存为用例（A6）；评测阶段 + 让设计器修复（A7）；上线清单（A8，由现有 release-status 驱动）；评测花费预估（A9，按模型近 20 次平均单次花费 × 用例数，无数据时不显示数字）；发布 / 版本 / 快照；分享：公开、按账号或组定向分享（A15，现有 share API）、申请上架（A13，新表 `market_listing_requests` + `POST /api/agents/[id]/listing-request`）；接入：内联签发限定 Key、代码、在线试调（A16，新 `POST /api/agents/[id]/try` 走登录态鉴权、复用 invoke 编排、计入本人）、Webhook；运行：列表 + 详情抽屉 + 取消运行 + 7 天统计（A17，usage 接口加 agent 过滤）。

**阶段 6 开发者与账户**：`/developer/keys`（Key 签发、限额、轮换、吊销、签名密钥卡）、`/developer/runs`；`/account/billing` 合并 packages 为页签并让 `/account/packages` 重定向；usage、prices、security、audit 照原型。

**阶段 7 平台管理**：账号页加「用户组」页签（A15，现有 `/api/groups`）；`/admin/models` 合并提供者 / 模型总览 / 默认路由（`/admin/providers` 重定向，详情改 `/admin/models/providers/[id]`）；市场上架加「上架申请」页签（A13 审核端）；`/admin/ops` 合并平台用量 / 运行 / 审计（三个旧地址重定向）；套餐、计费照原型。

**阶段 8 收尾**：全站 375 宽适配（顶栏抽屉、构建页单栏切换、对话底部抽屉）；playwright 补齐主流程用例（新建 → 设计器 → 试聊存用例 → 评测 → 发布 → 签 Key → 试调）；更新 `agents.md` 第 6.1 节与 README 截图；删除 `src/components/ide/` 与 `space-shell.tsx` 残留。
