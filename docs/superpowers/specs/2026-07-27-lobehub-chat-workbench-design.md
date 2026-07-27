# LobeHub 风格聊天工作台重构设计

## 目标

重构首页智能体聊天工作台，选择性复用本机
`/Users/liuyuhua/github/lobehub` 中可独立运行的 UI 组件、样式结构与公开包依赖，
获得接近 LobeHub 的聊天体验，同时保留 Open Web Agents 现有的领域模型、
Claude Agent SDK 集成、SSE 事件流、审批、分支重跑、文件工作区和后端接口。

本次只覆盖首页 `/` 的聊天工作台。助手构建器及其他管理页面不在本阶段范围内。

## 使用边界

本项目当前用途为个人研究。迁移代码时保留来源说明，并在新增的第三方说明文件中记录
LobeHub 来源与许可证。若未来改为商业分发，必须重新审查 LobeHub Community License
并取得所需授权。

## 核心原则

1. UI 可以复用，领域状态不迁移。
2. 后端协议不变，前端通过适配层消费现有 `Turn[]` 和 `AgentEvent[]`。
3. 不把 LobeHub 的聊天 store、SWR 请求、数据库消息模型或模型供应商调用链带入本项目。
4. 每个阶段都保持首页可运行，不进行无法验证的大爆炸替换。
5. 对话主流程优先；未接入的 LobeHub 功能不展示虚假按钮。

## 依赖复用

新增并锁定与本地 LobeHub 对齐的主要依赖：

- `@lobehub/ui@^5.23.0`
- `@lobehub/editor@^4.19.1`
- `antd@6.3.5`
- `antd-style@4.1.0`
- `lucide-react@^1.22.0`

优先直接使用公开包提供的 `Flexbox`、`Avatar`、`ActionIcon`、`Tooltip`、
`DropdownMenu`、`Markdown`、`ChatInput` 等组件。只有公开包无法覆盖的聊天展示结构，
才从 LobeHub 源码迁移并改造成无 store 依赖的本地组件。

## 工作台布局

### 桌面端

工作台由五个区域组成：

1. **应用导航栏**：窄图标栏，提供工作台、构建器、群组、用量和设置入口。
2. **会话侧栏**：助手选择、新建会话、会话搜索和会话列表。
3. **聊天主区**：智能体标题、消息列表、审批栏与组合输入器。
4. **运行检查器**：工具调用、子代理、状态、用量和产物汇总，可折叠。
5. **文件预览层**：继续复用现有文件 API，在运行检查器中打开，不占用固定第四栏。

聊天正文使用受约束的阅读宽度，输入器固定在主区底部，但不遮挡最后一条消息。

### 移动端

- 应用导航栏缩成顶部操作区。
- 会话侧栏改为左侧抽屉。
- 运行检查器改为右侧抽屉。
- 消息区与输入器始终占满可用宽度。
- 所有固定尺寸控件具有稳定宽高，切换运行状态时不引发布局跳动。

## 组件边界

### 保留的现有职责

`src/features/workbench/workbench.tsx` 继续负责：

- 加载 assistants 和 sessions。
- 创建与切换会话。
- 发起运行、读取 SSE、取消运行。
- 分支重跑。
- 刷新文件状态。

实现过程中可将这些职责提取到 `useWorkbenchController`，但不改变其 API 行为。

### 新增本地组件

建议拆分为：

- `WorkbenchShell`：响应式整体布局。
- `AppRail`：一级导航。
- `SessionSidebar`：助手与会话导航。
- `ChatHeader`：当前助手、会话和运行状态。
- `ConversationViewport`：消息滚动与自动贴底。
- `ChatMessage`：无 store 依赖的 LobeHub 风格消息壳。
- `ToolCallGroup`：工具调用与结果折叠展示。
- `QuestionCard`：保留现有可交互提问语义。
- `ResultNotice`：成功、失败、未知三态结果。
- `WorkbenchComposer`：基于 `@lobehub/editor` 的输入器。
- `RunInspector`：从事件派生运行摘要。
- `WorkbenchErrorBoundary`：隔离展示组件异常。

### 不直接迁移的 LobeHub 组件

以下组件与 LobeHub store、路由和服务层耦合过深，不整体复制：

- `Conversation/ChatList`
- `Conversation/Messages`
- `AgentSidebar`
- `ChatInput` 的业务 store、模型选择、文件 store 和发送动作

可以迁移它们内部无业务依赖的视觉结构、样式和小型展示组件。

## 数据适配

新增纯函数适配层：

```text
Turn[] / AgentEvent[]
        |
        v
conversation-adapter.ts
        |
        v
ChatMessageViewModel[] + RunInspectorViewModel
```

视图模型至少覆盖：

- 用户消息。
- 助手文本与思考内容。
- 按 `toolUseId` 配对的工具调用和工具结果。
- 子代理归属。
- 用户提问及其选项。
- artifact。
- status。
- success / failed / unknown 三态结果。
- 按 `messageId` 去重后的 token 用量。

适配器不得修改原始事件对象，避免当前 `foldEvents` 中原地补写工具结果造成的隐藏副作用。

## 输入器

组合输入器使用 `@lobehub/editor` 提供的编辑器外壳，但状态由本项目控制：

- 输入值仍归工作台控制器所有。
- Enter 发送，Shift+Enter 换行。
- 运行中发送按钮替换为固定尺寸停止按钮。
- 停止调用现有 `/api/sessions/:id/cancel`。
- 附件、技能和 MCP 操作只有在对应业务能力接通后才显示。
- 提问选项仍绕过输入框，直接作为下一轮调用现有 `send(text)`。

## 运行检查器

运行检查器完全由当前轮次事件派生，不新增后端字段：

- 当前状态与最终结果。
- 工具调用总数、成功数和失败数。
- 子代理列表及其活动事件。
- 待审批与审批结果。
- 输入/输出 token。
- artifact 与工作区文件入口。

检查器关闭时，主聊天区自动扩展；打开时不改变消息正文最大阅读宽度。

## 错误处理

- 每条消息和工具组使用局部 Error Boundary，单条展示失败不影响整段会话。
- Markdown 渲染失败时回退为纯文本。
- 工具输入或结果无法序列化时显示安全占位文本。
- SSE、取消、分支重跑错误沿用当前结果事件路径。
- 会话或助手列表加载失败时保留壳层并显示可重试状态。
- LobeHub 组件包初始化失败时提供基础 HTML 控件降级，不阻断对话。

## 测试策略

### 单元测试

- 对话适配器采用 TDD。
- 覆盖工具配对、无 ID 工具结果、子代理、问题事件、结果三态、artifact 和用量去重。
- 验证适配器不修改输入事件。
- 运行检查器摘要使用纯函数测试。

### 组件测试

- 用户与助手消息布局。
- 工具组折叠与错误态。
- 历史问题不可回答、最新问题可回答。
- 输入器发送、换行和停止。
- 会话切换不串用旧消息。

### 浏览器验收

使用 Playwright 检查：

- 桌面、平板和手机布局无重叠与横向溢出。
- 会话侧栏与运行检查器抽屉。
- 发送、停止、切换会话、提问选项和分支重跑。
- Markdown、长代码、长工具参数和长文件名。
- 深色模式。

### 工程验证

- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`

## 分阶段交付

1. 引入依赖、Provider 和响应式工作台壳层。
2. 完成纯适配器与消息展示替换。
3. 接入组合输入器。
4. 接入运行检查器和文件入口。
5. 完成响应式、深色模式、浏览器验收和旧组件清理。

## 完成标准

- 首页已使用新工作台，无旧版视觉残留。
- 现有发送、停止、审批、提问、分支重跑和文件能力保持可用。
- 桌面与移动端均通过浏览器验收。
- 所有新增组件不依赖 LobeHub 业务 store。
- 全量测试、类型检查、lint 和生产构建通过。
