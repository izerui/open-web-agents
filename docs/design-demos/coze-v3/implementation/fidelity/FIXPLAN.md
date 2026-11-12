# 还原度修复计划（2026-11-13）

依据：同目录四份 `*/FINDINGS.md`（对照图在各自目录，未入库，路径 `/Users/liuyuhua/github/open-web-agents/docs/design-demos/coze-v3/implementation/fidelity/<区域>/`）。
目标：把交互、反馈、流程衔接补到原型水平。修复分四组并行，各自在独立 worktree 里做。

## 已定的取舍（各组照此执行）

1. **设计器自动开始**：从新建弹层带描述进入（`?desc=`）、会话还没有任何轮次时，自动把描述发给设计器（用户已在弹层里明确点了「用设计器创建」，属于明确意图），发完从地址里去掉 `desc`。积分不足等失败照常显示错误。
2. **等待审批时发消息**：有待确认的工具调用时，新消息进排队区（本轮结束后发送），toast「已排队，本轮结束后发送」；有待回答的提问时拦下，toast「先回答提问，或选择不回答」，文字留在输入框。其余情况照旧 steer。
3. **克隆规则不改**（仍只能克隆已上架且已发布的智能体，这是现有服务端规则）：所有「克隆」入口统一为——不满足时按钮禁用并写明「只有已上架市场的智能体可以克隆」；可点时先弹确认框再克隆。只读说明文案不再写「或克隆一份来改」（不可克隆时）。
4. **Key 显示尾号**：允许新增迁移（只加列）：在 api_keys 加 `key_hint`（如 `owa_live_••••7Q2c`，签发时写入；旧 Key 为空则退回显示 ID）。
5. **Skills/MCP 来源「复制进来」不改为「只读引用」**（后端是复制语义）：作为有意偏差登记；界面上给复制进来的条目标「来自 X」，没有设计会话时加来源前先提示会新建设计会话。
6. **全站 toast**：改为底部居中、深色胶囊（原型 #toast）。
7. **全站时间格式**：一律 `MM-DD HH:mm`（跨年加年份），不跟浏览器语言走；在 `src/lib/` 提供一个格式函数并全站替换 `toLocaleString()` 一类调用。
8. **全站数字**：积分显示用整数/最多 2 位小数（`creditsAmount`），不显示 6 位；运行记录花费一律显示积分不显示美元。
9. **表单校验**：用户可见的表单统一 `noValidate` + 行内红字（登录、注册、账号安全、Key 表单、模型弹窗等），注册一律要求「再次输入密码」。
10. **网络错误文案**：`errorText` 识别网络错误（TypeError / Failed to fetch），统一为「网络异常，连不上服务」。
11. **手机端**：375 宽下增加底部标签栏（探索 / 对话 / 工作室 / 我的）与「我的」聚合页（`/me`，仅窄屏入口；内容：可用积分大卡、充值与订单、六个入口、登出前确认），对照原型 `mobile.html`。

## 分组

| 组 | 范围 | 主要条目 |
| --- | --- | --- |
| A 对话 | `src/features/workbench/*`、对话相关的 `message.tsx` 链接渲染 | chat F1–F12 全部，F13–F27 中合理的低项 |
| B 构建页 | `src/features/build/*`、`builder/knowledge-*` | build F1–F25（F5 按取舍 3，F10 按取舍 5） |
| C 外壳 / 探索 / 工作室 / 登录 / 手机 | `src/components/shell/*`、`src/components/ui/sonner.tsx`、`src/lib/fetch-json.ts`、新增 `src/lib/` 时间格式、`features/explore|studio|market|auth`、手机底部栏与 `/me` | explore-studio F1–F17；dev-account-admin F-06、F-35、F-36；取舍 6、7（提供函数）、9（登录/注册）、10、11 |
| D 开发者 / 账户 / 管理 | `features/integration|runs|billing|usage|audit|settings|admin|models`、api_keys 迁移 | dev-account-admin 其余全部（F-01–F-34、F-37）；取舍 4、7（替换调用）、8、9（Key/安全/模型弹窗） |

共享文件归属：时间格式函数由 C 新建（`src/lib/format-time.ts`，导出 `formatTime(ms: number): string`），A/B/D 直接按这个签名调用（合并前若文件不存在，各自先在本组内用同名临时实现，合并时以 C 为准）。
