# Open-Web-Agents 前端改进计划（参考 T3 Code）

## 第一批：低难度高收益（1-2 天）

### 功能改进
1. **运行计时** — "Working for Xs" useRef+setInterval 零 React commit
2. **思考指示器升级** — pulse 圆点 → LiveActivityRow + shimmer 扫描光效
3. **活跃工具指示** — 显示 "Running grep" 而不是模糊的"运行中"
4. **用户消息样式** — 右对齐 `bg-message rounded-2xl` 圆角气泡
5. **工具图标分类** — 2 种 → 6 种（terminal/eye/pen/search/wrench/bot）
6. **输入区浮动定位** — flex 布局 → absolute 底部浮动
7. **上下文用量圆环** — 纯文本 → SVG 圆环 + Popover 详情
8. **空状态 Hero** — 简单文字 → 大标题样式
9. **错误横幅** — 运行出错时顶部显示错误信息
10. **文件拖拽到对话区** — 拖文件上传

### 性能改进
11. **TurnView memo** — 历史轮不重渲，只有当前运行轮重渲
12. **React Compiler** — next.config.ts 一行配置，全局自动 memo
13. **自计时不触发 rerender** — useRef 直接改 DOM textContent

## 第二批：中难度（3-5 天）

### 功能改进
14. **工具按组折叠** — 全部一起折 → 相邻工具独立分组，每组可展开
15. **虚拟滚动** — 全量渲染 → 虚拟化（注意 SSR 兼容）
16. **三模式滚动锚定** — 贴底 → following/anchoring/free 三模式
17. **Slash 命令** — 输入 `/` 触发命令菜单
18. **侧栏内联搜索** — 命令面板搜索 → 侧栏顶部搜索框
19. **对话小地图** — 左侧缩略导航条，点击跳转

### 性能改进
20. **事件追加优化** — `[...events, e]` O(n) → useRef 缓冲 + rAF 批量 flush
21. **foldEvents 缓存** — 只对变化的轮重算，历史轮用 useMemo 缓存
22. **组件拆分 + .logic.ts** — 渲染层 + 纯逻辑层分离
23. **memo 关键组件** — TurnView、ToolGroup 等加 memo

## 第三批：高难度需规划（1-2 周）

### 功能改进
24. **文件变更摘要** — 每轮显示 ChangedFilesTree（需后端支持）
25. **@ mention 文件** — 输入 `@` mention 工作区文件
26. **Diff 面板** — 专业代码差异渲染
27. **终端面板** — PTY 终端抽屉（需后端 PTY 支持）
28. **Lexical 富文本输入** — textarea → Lexical 编辑器
29. **消息暂存** — 暂存未发送消息
30. **Git Checkpoint** — 逐轮文件系统快照 + 回滚（需后端支持）

### 性能改进
31. **细粒度状态管理** — useState 全量重渲 → Zustand 细粒度订阅
32. **行引用稳定性** — useStableRows 浅比对复用旧引用

## 不做
- 多项目支持（定位不同）
- WebSocket 替换 SSE（需要新容器，SSE 已够用）
- 拖拽排序会话（按时间排序更合理）
- @base-ui 替换 Radix（API 不兼容，成本太高）
