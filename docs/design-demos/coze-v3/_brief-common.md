# 全量原型 · 共同规则（每个子代理必读）

你在做 Open Web Agents（AI 智能体搭建/评测/发布/接入＋市场＋积分＋平台管理）的**全量高保真原型**。用户已从三个方向里选定 **dir-2「对话搭建」**，原话：「dir-2.html 我选择了就是用这个，你基于这个把所有功能然后对齐了给我出一版。」所有界面文案用中文。

## 必读
1. `docs/design-demos/coze-v3/spec.md`：受众、业务约束、演示内容（报销审核助手等）、可读性底线
2. `docs/design-demos/coze-v3/information-architecture.md`：一级空间、构建页五阶段、旧路由→新位置。**功能归属照此**
3. `docs/design-demos/coze-v3/features.md`：从代码盘点的完整功能清单。**你负责的页面里，清单上对应的每个字段、操作、状态（空/加载/错误/禁用/只读/运行中）、跨页跳转都要出现，一个不漏**；第 5 节「API 有、UI 无」的能力按 IA 第 7 节补上；需要新后端的标 `<span class="need-backend">需后端</span>`
4. `docs/design-demos/coze-v3/dir-2.html` 与截图 `dir-2-*.png`：选定方向的视觉与交互基准（暖灰白底、衬线大标题、圆形眼睛头像、黑色胶囊按钮、灰绿完成色、白色大圆角卡片）。可以从里面复制代码片段
5. `docs/design-demos/coze-v3/prototype/assets/owa.css`、`owa.js`：**共用设计系统与外壳，必须使用**（OWA.mount、topnav、sideNav、av、ic、toast、openModal、confirmBox、openDrawer、MARKET/MY_AGENTS/SESSIONS/USER/ADMIN 数据、OWA.st 跨页状态、OWA.on 事件）。样板页：`prototype/account-security.html`，照它的结构写

## 硬规则
- **只写你被分配的文件**（在 `docs/design-demos/coze-v3/prototype/` 下）和 `prototype/shots/<你的页面名>*.png`。**不要修改 owa.css / owa.js / 别人的页面**；需要额外样式就写在自己页面的 `<style>` 里（类名加页面前缀避免冲突）。需要共用层改动，在最终回复里写明，由协调者统一改
- **严禁修改 `src/` 和仓库里任何其他文件**
- 页面结构：`<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@600;700&display=swap" rel="stylesheet"><link rel="stylesheet" href="assets/owa.css">`，`<div id="app"></div>`，`<script src="assets/owa.js"></script>`，再写页面脚本（原生 JS，"use strict"）
- 页面间用真实链接跳转（文件名见 owa.js 的 PAGES）；所有按钮、页签、筛选、展开、弹层、抽屉都要真能点；危险操作用 confirmBox；运行/加载用 setTimeout 模拟；控制台零报错
- 设计目标视口 1440×900（最小宽 1280），内容区内部滚动
- 演示数据和 spec 一致：当前用户 林舟（普通账号，12,480 积分可用、冻结 120、本月已用 1,862）；管理员 周岚；主角「报销审核助手」expense-reviewer；市场智能体见 owa.js MARKET
- 可读性：正文 ≥14px，标签 ≥12px，对比度 ≥4.5:1；不用 emoji 当图标（用 ic()）；不用 Lorem；不加模板装饰（标题上方全大写小标签、按钮尾巴「→」、无序内容编号 01/02）
- 「原型目录」浮标由 owa.js 自动加，不用管

## 验证（必须做）
用 agent-browser（PATH 里有），**用你自己的会话名**（简报里给出）：
`agent-browser --session <名> set viewport 1440 900`
`agent-browser --session <名> open file:///Users/liuyuhua/github/open-web-agents/docs/design-demos/coze-v3/prototype/<页面>.html`
点各个交互后截图：`agent-browser --session <名> screenshot /Users/liuyuhua/github/open-web-agents/docs/design-demos/coze-v3/prototype/shots/<页面>[-状态].png`（**一律绝对路径**）。每张截图都用看图能力亲眼看，修掉重叠、溢出、截断、对齐、对比度问题再截。用 `agent-browser --session <名> errors` 查 JS 报错（会话里可能残留别的站的日志，以你页面的报错为准）。
最后：`python3 /Users/liuyuhua/.claude/skills/huashu-design/scripts/design_lint.py check <你的每个 html 绝对路径>`，红灯必修，黄灯模板装饰删掉。没装 Python 版 playwright 时它会跳过体检，**不要去安装任何东西**。

## 回报（最终回复，中文，简短）
每个页面：覆盖了 features.md 的哪些条目、刻意没做或做不了的、截图文件清单、lint 结果、需要协调者改共用层的地方。
