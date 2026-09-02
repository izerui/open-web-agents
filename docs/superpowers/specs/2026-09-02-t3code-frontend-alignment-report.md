# T3 Code 前端对齐分析报告

## 背景

本次工作目标是把 t3code（一个成熟的 AI Agent IDE 前端）的前端经验引入 open-web-agents 项目。经过深入分析和多次尝试，以下是完整的发现和建议。

## 两个项目的定位差异

| | T3 Code | Open-Web-Agents |
|---|---|---|
| 定位 | 个人开发者的本地 Agent IDE | 企业级会话执行 Agent 平台 |
| 框架 | Vite + TanStack Router（纯 CSR） | Next.js 16 App Router（SSR + CSR） |
| UI 底层 | @base-ui/react | Radix UI + shadcn/ui |
| 状态管理 | Zustand + Effect Atom | useState + fetch |
| 输入区 | Lexical 富文本（4265 行） | 简单 textarea（PromptInput） |
| 数据传输 | WebSocket + Effect RPC | SSE + Redis Stream |
| 规模 | ~70 万行 TS/TSX，2480 个测试 | ~5 万行，55 个测试 |

## 本次尝试的路径和教训

### 路径 1：直接搬 t3code 的 MessagesTimeline（失败）

**做了什么**：复制了 MessagesTimeline.tsx（2539 行）+ .logic.ts（1069 行）+ 14 个子组件 + 20 个 UI 组件 + 25 个 stub 文件，共 94 个文件 ~17,800 行。

**失败原因**：
1. **数据模型鸿沟**：t3code 的 `WorkLogEntry` 有 36 个字段，每个字段的精确值（`tone: "tool"/"thinking"/"info"/"error"`、`toolLifecycleStatus: "inProgress"/"completed"`、`itemType`、`requestKind` 等）决定了渲染逻辑。我们的 `AgentEvent` 是完全不同的结构，适配器永远修不完。
2. **LegendList + Next.js SSR 冲突**：t3code 是纯 CSR（Vite），LegendList 在 SSR hydration 下会出现元素重复渲染。虽然 `dynamic({ ssr: false })` 能缓解，但增加了复杂度。
3. **CSS 类冲突**：t3code 的 `live-activity-focus` 设了 `position: relative`，覆盖了 Tailwind 的 `absolute`，导致 shimmer overlay 渲染为可见文本（"Thinking" 显示两个）。
4. **UI 组件 API 不兼容**：t3code 的 Button 用 `render` prop，shadcn 用 `asChild`；Alert 的 variant 名不同；Command 组件 API 完全不同。

### 路径 2：用我们的数据模型 + t3code 的视觉风格（部分成功）

**做了什么**：重写 conversation.tsx，用 `foldEvents` + 自己的渲染组件，但 CSS 样式和交互模式对标 t3code。

**成功的部分**：
- 用户消息右对齐 `bg-message` 圆角气泡 ✅
- `WorkingTimer` 零 React commit 计时 ✅
- `LiveActivityRow` 带扫描光效 ✅
- 工具调用可折叠/展开 ✅
- 工具实时显示（完成的 + 活跃的） ✅
- 暗色主题色板对齐 ✅

**仍有问题**：
- 对话区域布局（输入区定位、内容容器样式）还不够精细
- 整体页面框架（sidebar、header、输入区）仍是原始组件

## 可以直接采用的 t3code 实践

### 1. CSS 主题和视觉效果（零成本，直接可用）

从 t3code 的 `index.css` 复制以下 CSS 到 `globals.css`：

```css
/* 毛玻璃效果 */
.surface-glass { backdrop-filter: blur(16px) saturate(1.4); }
.dropdown-glass { backdrop-filter: blur(16px) saturate(1.08); }

/* 活动指示器扫描动画 */
@keyframes live-activity-scan { ... }
.live-activity-focus { overflow: hidden; } /* 注意不要加 position:relative */

/* 消息气泡背景 */
.bg-message { background: var(--accent); }

/* 顶栏滚动渐隐 */
.topbar-scroll-fade { mask-image: linear-gradient(...); }
```

### 2. WorkingTimer（零 React commit 的计时标签）

来源：`MessagesTimeline.tsx:1374-1394, 2093-2118`

```tsx
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const update = () => { if (textRef.current) textRef.current.textContent = formatWorkingTimerNow(createdAt); };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [createdAt]);
  return <span ref={textRef} className="tabular-nums">{formatWorkingTimerNow(createdAt)}</span>;
}
```

### 3. 文件拖拽处理器

来源：`workspaceFileDrop.ts`（55 行，零依赖，原样搬）

### 4. 滚动锚定

来源：`timelineScrollAnchoring.ts`（98 行，零依赖，原样搬）

### 5. ContextWindowMeter（上下文窗口用量圆环）

来源：`ContextWindowMeter.tsx`（162 行），需要适配 Popover API（shadcn vs base-ui）

### 6. 对话渲染的视觉模式

不搬 t3code 的组件代码，而是**参考其视觉效果**，在现有组件上调整样式：

| 元素 | t3code 样式 | 实现方式 |
|---|---|---|
| 用户消息 | 右对齐 `rounded-2xl bg-message p-3` | 在 ChatThread 的用户消息 div 上改 className |
| 工具折叠 | "Worked for Xs ∨" + 图标 + 摘要 | 替换现有 ChainOfThought 为自定义折叠组件 |
| 助手回复 | 左对齐 + hover 显示 Copy/Rerun | 在 MessageActions 上加 `group-hover` |
| 运行指示 | "Working for Xs" + 分隔线 | 在运行态 turn 顶部加分隔线和计时器 |
| Thinking | 单个 + 扫描动画 | `LiveActivityRow` 组件 + `live-activity-focus` CSS |
| 用量 | pill badge + tabular-nums | Badge 改为圆角 pill 样式 |

### 7. Turn 类型增加 `startedAt`

```ts
interface Turn {
  // ...现有字段
  startedAt?: string; // ISO 时间戳，用于计时标签
}
```

在 `send` 和 `rerun` 函数创建 turn 时记录 `new Date().toISOString()`。

## 不建议采用的部分

| t3code 特性 | 原因 |
|---|---|
| **MessagesTimeline 整体搬入** | 数据模型差异太大，适配器维护成本高于收益 |
| **@base-ui/react 替换 Radix** | API 完全不同（render vs asChild），需要改所有组件 |
| **LegendList 虚拟列表** | 与 Next.js SSR 有 hydration 冲突，需要 `ssr: false` workaround |
| **Effect + Zustand 状态管理** | 学习曲线极陡，现有 useState + fetch 对企业平台够用 |
| **Lexical 富文本输入** | 4265 行的 ChatComposer，依赖链太深 |
| **批量替换 shadcn → base-ui** | 组件 API 不兼容，需要逐个适配 |

## 推荐的实施方案

### 短期（1-2 天）：视觉对齐

在**不改组件库**的前提下，修改 CSS 和组件 className：

1. 添加 t3code 的 CSS utilities 到 `globals.css`
2. 重写 `conversation.tsx` 的 `ChatThread`——用现有 ai-elements 组件，但布局和样式对标 t3code
3. 加入 `WorkingTimer` 和 `LiveActivityRow` 子组件
4. 工具调用改为可折叠（替换 ChainOfThought 的"全部折叠"模式为"按组折叠"）
5. 输入区改为 absolute 底部浮动

### 中期（1 周）：功能增强

1. 加入 `ContextWindowMeter` 上下文用量圆环
2. 加入文件拖拽（workspaceFileDrop）
3. 加入 "Scroll to end" 按钮
4. 加入对话小地图（Timeline Minimap）——纯 UI 实现，不依赖 t3code 代码

### 长期：完整的前端重建

如果确实要 100% 对齐 t3code 的体验，正确的路径是：

1. Fork `t3code/apps/web/` 作为独立前端工程
2. 保留 Vite 构建（不换 Next.js）
3. 替换 `@t3tools/client-runtime` 的数据获取层为调 open-web-agents 的 SSE API
4. 后端（Next.js API routes + MySQL + Redis）完全不动
5. 前端独立部署（Nginx 反代 API 到后端）

这是最干净的方案，但也是工作量最大的。

## 本次工作的产出（保存在 git stash）

所有改动保存在 `git stash`（名称 `t3code integration work - to be reviewed`），包含：
- 94 个 t3code 文件（t3-chat/ + t3-ui/ + t3-compat/）
- 暗色主题色板对齐
- CSS utilities（glass、shimmer、fade 等）
- 数据适配器（t3-adapter.ts）
- 多个版本的 conversation.tsx 重写

可以通过 `git stash pop` 恢复。
