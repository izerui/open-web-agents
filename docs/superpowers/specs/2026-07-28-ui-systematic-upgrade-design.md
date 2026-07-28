# UI 系统化升级设计

- 状态：草案
- 日期：2026-07-28
- 范围：引入 shadcn/ui 生态，系统化解决视觉品质、代码重复、交互体验三大痛点

---

## 1. 现状问题

### 1.1 代码重复

- `field` CSS 常量在 `builder.tsx`、`settings-view.tsx`、`groups-view.tsx` 中各定义一遍
- 每个页面都有相同的 header 导航链接（工作台/构建器/设置/用量）
- 数据获取模式 `fetch → useState → useEffect → reload` 在 7 个视图中重复

### 1.2 视觉品质

- 按钮、输入框、选择器全是裸 Tailwind class，缺乏一致的设计语言
- 无 hover/focus/active 状态的精细过渡
- 暗色模式靠 `dark:` 前缀逐条手写，缺少设计变量体系

### 1.3 交互体验

- 无 toast 提示：保存成功/失败只在原地显示一行文字
- 无加载骨架屏：数据获取期间页面空白
- 工具调用折叠用原生 `<details>`，无动画
- 无 tooltip：很多缩写/图标含义不明

---

## 2. 引入依赖清单

| 包 | 用途 | 类型 |
|---|---|---|
| `clsx` | 条件 class 合并 | 运行时 |
| `tailwind-merge` | Tailwind class 冲突合并 | 运行时 |
| `class-variance-authority` | 组件变体（size/variant） | 运行时 |
| `lucide-react` | 图标库 | 运行时 |
| `sonner` | Toast 通知 | 运行时 |
| `@radix-ui/react-*` | shadcn 底层原语（按需引入） | 运行时 |

**不引入**：SWR（留到第二阶段，本次聚焦 UI 层）

---

## 3. 架构设计

### 3.1 目录结构

```
src/
  components/
    ui/                    ← shadcn 组件（复制到项目的源码）
      button.tsx
      input.tsx
      textarea.tsx
      select.tsx
      card.tsx
      badge.tsx
      dialog.tsx
      tooltip.tsx
      tabs.tsx
      scroll-area.tsx
      sheet.tsx             ← 移动端侧边栏抽屉
      separator.tsx
      skeleton.tsx          ← 加载骨架屏
      collapsible.tsx       ← 替代原生 <details>
      sonner.tsx            ← Toast 容器
    app-header.tsx          ← 统一顶部导航栏（替代各页面重复的 header）
    nav-link.tsx            ← 导航链接（高亮当前页）
  lib/
    utils.ts               ← cn() 工具函数
```

### 3.2 cn() 工具

```ts
// src/lib/utils.ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

所有组件用 `cn()` 替代手写的条件 class 拼接。

### 3.3 CSS 变量体系

在 `globals.css` 中建立 shadcn 标准设计变量，替换现有的仅有 `--background` / `--foreground` 两个变量：

```css
@import "tailwindcss";

:root {
  --background: 0 0% 100%;
  --foreground: 0 0% 3.9%;
  --card: 0 0% 100%;
  --card-foreground: 0 0% 3.9%;
  --popover: 0 0% 100%;
  --popover-foreground: 0 0% 3.9%;
  --primary: 0 0% 9%;
  --primary-foreground: 0 0% 98%;
  --secondary: 0 0% 96.1%;
  --secondary-foreground: 0 0% 9%;
  --muted: 0 0% 96.1%;
  --muted-foreground: 0 0% 45.1%;
  --accent: 0 0% 96.1%;
  --accent-foreground: 0 0% 9%;
  --destructive: 0 84.2% 60.2%;
  --destructive-foreground: 0 0% 98%;
  --border: 0 0% 89.8%;
  --input: 0 0% 89.8%;
  --ring: 0 0% 3.9%;
  --radius: 0.5rem;
}

.dark {
  --background: 0 0% 3.9%;
  --foreground: 0 0% 98%;
  /* ... 完整暗色变量 */
}
```

### 3.4 统一导航

抽取 `AppHeader` 组件替代各页面重复的 header + 导航链接：

```tsx
// src/components/app-header.tsx
export function AppHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="flex items-center justify-between">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      <nav className="flex items-center gap-3 text-xs">
        <NavLink href="/">工作台</NavLink>
        <NavLink href="/builder">构建器</NavLink>
        <NavLink href="/groups">组</NavLink>
        <NavLink href="/usage">用量</NavLink>
        <NavLink href="/settings">设置</NavLink>
      </nav>
    </header>
  );
}
```

### 3.5 Toast 集成

在根 layout 加入 Sonner 的 `<Toaster />`，各页面用 `toast.success()` / `toast.error()` 替代 `setMsg()` 模式：

```tsx
// src/app/layout.tsx
import { Toaster } from "@/components/ui/sonner";

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
```

---

## 4. 迁移策略

**原则**：渐进替换，每步可独立部署，不破坏现有功能。

### 第一步：基础设施（不改任何现有页面）

1. 安装依赖：`clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`, `sonner`
2. 初始化 shadcn/ui（`npx shadcn@latest init`）
3. 创建 `src/lib/utils.ts`（cn 函数）
4. 更新 `globals.css` 设计变量
5. 在根 layout 加 `<Toaster />`
6. 添加 shadcn 组件：Button, Input, Textarea, Select, Card, Badge, Dialog, Tooltip, Skeleton, Collapsible, Separator, ScrollArea, Sheet

### 第二步：抽取公共组件

1. 创建 `AppHeader` + `NavLink`
2. 验证暗色模式正常

### 第三步：逐页迁移（从简单到复杂）

按此顺序逐个替换，每完成一个页面即可提交：

| 顺序 | 页面 | 主要替换点 | 复杂度 |
|------|------|-----------|--------|
| 1 | `login-form.tsx` | Input, Button | 低 |
| 2 | `settings-view.tsx` | Input, Button, Card, toast 替代 setMsg, AppHeader | 低 |
| 3 | `groups-view.tsx` | Input, Button, Card, AppHeader | 低 |
| 4 | `usage-view.tsx` | Card(Stat), Select, AppHeader | 低 |
| 5 | `builder.tsx` | Input, Textarea, Select, Card, Badge, Dialog, Tooltip, Collapsible(MCP/子代理), AppHeader | 高 |
| 6 | `workbench.tsx` | Sheet(移动端侧边栏), ScrollArea, Button, Select | 中 |
| 7 | `conversation.tsx` | Collapsible(替代 details), Badge, Card, Button, Tooltip | 中 |
| 8 | `approval-bar.tsx` | Card, Button, Badge | 低 |
| 9 | `file-panel.tsx` | ScrollArea, Button, Skeleton | 低 |

### 第四步（可选后续）：数据层升级

引入 SWR 替换裸 fetch 模式——这是独立的后续工作，不在本次 UI 改造范围内。

---

## 5. 不做的事（YAGNI）

- 不引入全局状态管理（Zustand/Redux）——当前 Context + 本地 state 够用
- 不引入 SWR——留给下一阶段
- 不做布局大改（如三栏变两栏）——只替换原子组件，保持现有布局
- 不做暗色模式切换 UI——保持跟随系统
- 不引入动画库（framer-motion）——shadcn 自带的 CSS 过渡够用
- 不做移动端适配——保持桌面端优先

---

## 6. 验收标准

1. 所有页面使用 shadcn 组件，无裸 `<button>`/`<input>`/`<select>`
2. `field` 常量从所有文件中消失
3. 各页面 header 导航由 `AppHeader` 统一提供
4. 保存/删除/签发等操作有 toast 反馈
5. 工具调用折叠有平滑展开动画（Collapsible 替代 `<details>`）
6. 暗色模式通过 CSS 变量统一控制，无视觉异常
7. `pnpm build` 无报错，`pnpm typecheck` 无报错
