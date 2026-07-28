# AI Elements 迁移实施计划

## 核心适配策略

我们的数据模型是 `Turn[]`（每个 Turn 包含 prompt + AgentEvent 事件流），
ai-elements 期望的是 role-based message + parts。
**适配方式**：在渲染层将 Turn 映射到 ai-elements 组件，不改变底层数据流。

## 文件变更清单

### 1. workbench.tsx — 主框架重写
- 对话区域：`<Conversation>` + `<ConversationContent>` + `<ConversationScrollButton>`
  替代手写的 scrollRef + overflow-y-auto
- 输入区域：`<PromptInput>` + `<PromptInputTextarea>` + `<PromptInputSubmit>`
  替代手写的 Input + Button（发送/中断）
- 助手选择：`<PromptInputSelect>` 替代 NativeSelect
- 侧边栏/文件面板：保持不变（不属于 ai-elements 范畴）

### 2. conversation.tsx — 消息渲染重写
- 用户消息：`<Message from="user">` + `<MessageContent>`
- 助手文本：`<Message from="assistant">` + `<MessageResponse>`（自带 Markdown 渲染）
- 思考过程：`<Reasoning>` + `<ReasoningTrigger>` + `<ReasoningContent>`
- 工具调用：`<Tool>` + `<ToolHeader>` + `<ToolContent>` + `<ToolInput>` + `<ToolOutput>`
- agent 提问：`<Suggestion>` + `<Suggestions>` 替代 QuestionBlock 的选项按钮
- 结果状态：保留 Badge（ai-elements 没有等价组件）
- 重跑按钮：`<MessageActions>` + `<MessageAction>`

### 3. approval-bar.tsx — 审批重写
- `<Confirmation>` + `<ConfirmationRequest>` + `<ConfirmationActions>` + `<ConfirmationAction>`
  替代手写的 Card + Button

### 4. file-panel.tsx — 文件面板重写
- `<FileTree>` + `<FileTreeFolder>` + `<FileTreeFile>` 替代手写的列表
  注意：FileTree 是静态展示型，我们需要点击目录时动态加载，需要适配

### 5. 清理
- 删除不再使用的自定义组件导入
- 删除 conversation.tsx 中的 foldEvents/ToolBlock/EventBlock/QuestionBlock（被 ai-elements 替代）
- 确保 workbench.tsx 中的 chat-header 组件（如果有）统一

## 不做的事
- 不改变事件流模型（Turn/AgentEvent）
- 不引入 Vercel AI SDK 的 useChat
- 不改变 API 路由
- 不改变侧边栏结构（非 chat 区域）
- 不改变 builder/settings/groups/usage 页面（已用 shadcn 改完）

## 执行顺序
1. workbench.tsx（主框架 + PromptInput）
2. conversation.tsx（消息渲染，最复杂）
3. approval-bar.tsx
4. file-panel.tsx
5. 构建验证
