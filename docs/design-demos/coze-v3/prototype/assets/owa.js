"use strict";
/*
 * Open Web Agents 原型 / 共用脚本（所有页面先引用 owa.css 与本文件）
 * 提供：$/$$/esc/later、图标 ic()、智能体头像 av()、演示数据、顶栏 topnav()、
 *       账号菜单、⌘K 跳转面板、toast / modal / drawer、侧栏 sideNav()、跨页演示状态 OWA.st
 * 页面写法：
 *   OWA.mount({ nav: "studio", body: "<div>…</div>" })   // 渲染顶栏＋页面主体
 *   OWA.on("动作名", (el, ev) => {...})                  // 处理 data-a="动作名" 的点击
 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const later = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 图标（线性 24 栅格） ---------- */
const P = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  clip: '<path d="M20 11.5l-8.3 8.3a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 7.2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 19c1-3.5 3.6-5 6.5-5s5.5 1.5 6.5 5"/><circle cx="17" cy="9" r="2.6"/><path d="M17 14c2.3 0 4 1.2 4.7 4"/>',
  text: '<path d="M5 6h14M5 11h14M5 16h9"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  brace: '<path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 3-2 3 1 0 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 3 2 3-1 0-2 1.5-2 3v2c0 2-1 3-3 3"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  hook: '<path d="M8 4v8a4 4 0 0 0 8 0M16 12l2-2M16 12l-2-2"/><circle cx="8" cy="4" r="1.5"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  home: '<path d="M4 11l8-7 8 7v9H4z"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.5M4 12h.5M4 18h.5"/>',
  coin: '<circle cx="12" cy="12" r="8"/><path d="M9.5 9.5h4a1.8 1.8 0 0 1 0 3.5h-3a1.8 1.8 0 0 0 0 3.5h4M12 7.5v1.8M12 16.5v-1.8"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  logout: '<path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M10 16l-4-4 4-4M6 12h10"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  store: '<path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  audit: '<path d="M9 4h6M8 4H6a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-2"/><path d="M9 12l2 2 4-4"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8M10 12h4"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11 7"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  filter: '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  terminal: '<path d="M5 8l4 4-4 4M12 17h7"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 8"/>',
  rewind: '<path d="M11 18l-7-6 7-6zM20 18l-7-6 7-6z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
};
/** 差异标注：gap("A3") → 与 gaps.md 编号对应的小标，默认隐藏，打开「差异标注」开关后显示 */
const gap = (id, text = "") => `<span class="gap" title="见 gaps.md ${id}">${id}${text ? " " + text : ""}</span>`;
const ic = (n, s = 18, w = 1.7) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ""}</svg>`;

/* ---------- 智能体身份：色块＋两只眼睛（市场、会话、工作室处处一致） ---------- */
const AV = {
  "expense-reviewer": { c: "#F2B49B", e: "pill" },
  builder: { c: "#1F1E1C", e: "white" },
  default: { c: "#E6E1D6", e: "dot" },
  meeting: { c: "#C8C2E8", e: "round" },
  rival: { c: "#E7D2AA", e: "side" },
  review: { c: "#CADBCF", e: "pill" },
  sql: { c: "#B9D0E8", e: "dot" },
  xhs: { c: "#F4B3C3", e: "round" },
  contract: { c: "#E3C59D", e: "dot" },
  kb: { c: "#C9DDBD", e: "side" },
  weekly: { c: "#DAD3C4", e: "round" },
  currency: { c: "#B8DCD6", e: "dot" },
  travel: { c: "#F0D58C", e: "pill" },
};
function av(k, s = 32) {
  const a = AV[k] || { c: "#DDD7CA", e: "dot" };
  let eyes = "";
  if (a.e === "pill") eyes = '<rect x="13.2" y="13.5" width="4.6" height="10" rx="2.3" fill="#1B1B1A"/><rect x="22.2" y="13.5" width="4.6" height="10" rx="2.3" fill="#1B1B1A"/><circle cx="15" cy="16" r="1" fill="#fff"/><circle cx="24" cy="16" r="1" fill="#fff"/>';
  else if (a.e === "white") eyes = '<rect x="13.2" y="13.5" width="4.4" height="10" rx="2.2" fill="#fff"/><rect x="22.4" y="13.5" width="4.4" height="10" rx="2.2" fill="#fff"/>';
  else if (a.e === "round") eyes = '<circle cx="15" cy="18" r="4.4" fill="#fff"/><circle cx="25" cy="18" r="4.4" fill="#fff"/><circle cx="16" cy="18.6" r="2.2" fill="#1B1B1A"/><circle cx="26" cy="18.6" r="2.2" fill="#1B1B1A"/>';
  else if (a.e === "side") eyes = '<ellipse cx="16" cy="19" rx="2" ry="3.4" fill="#1B1B1A"/><ellipse cx="24" cy="19" rx="2" ry="3.4" fill="#1B1B1A"/><circle cx="16.6" cy="17.6" r=".8" fill="#fff"/><circle cx="24.6" cy="17.6" r=".8" fill="#fff"/>';
  else eyes = '<circle cx="15.5" cy="19" r="2.1" fill="#1B1B1A"/><circle cx="24.5" cy="19" r="2.1" fill="#1B1B1A"/>';
  return `<svg class="av" width="${s}" height="${s}" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="19.5" fill="${a.c}"/><circle cx="14" cy="11" r="9" fill="#fff" opacity=".16"/><circle cx="20" cy="20" r="19" fill="none" stroke="rgba(0,0,0,.08)"/>${eyes}</svg>`;
}

/* ---------- 演示数据（全站共用，三处出现必须一致） ---------- */
const MARKET = [
  { k: "meeting", id: "meeting-notes", n: "会议纪要整理", cat: "办公运营", by: "星河数据 周岚", v: 5, price: "约 2 积分/次", uses: "1.8 万次", d: "上传录音或速记，十分钟内整理出决议、待办和负责人。", starters: ["整理今天的周会录音", "只列出待办和负责人", "按项目拆分纪要"] },
  { k: "rival", id: "rival-weekly", n: "竞品周报", cat: "研究分析", by: "市场部 陈一帆", v: 3, price: "约 6 积分/次", uses: "4,210 次", d: "每周抓取 6 家竞品的官网、公众号与招聘动态，汇总成周报。", starters: ["这周竞品有什么新动作", "对比三家的定价变化"] },
  { k: "review", id: "code-reviewer", n: "代码审查员", cat: "开发工具", by: "平台组 许牧", v: 7, price: "约 4 积分/次", uses: "2.6 万次", d: "读 diff 找正确性问题，按严重程度排序，给出可直接应用的修改。", starters: ["审一下这个 PR", "只看并发相关的问题"] },
  { k: "sql", id: "sql-helper", n: "SQL 助手", cat: "开发工具", by: "数据组 何晴", v: 4, price: "约 1 积分/次", uses: "3.1 万次", d: "用中文描述要查什么，生成可读的 SQL，并解释每个连接条件。", starters: ["上月各部门报销总额", "找出重复提交的发票"] },
  { k: "xhs", id: "xhs-copy", n: "小红书文案", cat: "内容创作", by: "品牌部 宋迪", v: 2, price: "约 2 积分/次", uses: "9,860 次", d: "按产品卖点写三版笔记，附标题、标签和配图建议。", starters: ["给新上线的耳机写一篇", "语气更口语一点"] },
  { k: "contract", id: "contract-diff", n: "合同条款比对", cat: "办公运营", by: "法务部 罗婧", v: 3, price: "约 8 积分/次", uses: "2,340 次", d: "比对两版合同的条款差异，标出对我方不利的修改。", starters: ["比对这两份采购合同", "只看付款与违约条款"] },
  { k: "kb", id: "support-kb", n: "客服知识问答", cat: "通用助手", by: "客服中心 唐悦", v: 6, price: "约 1 积分/次", uses: "6.4 万次", d: "基于产品手册回答客户问题，答不上来时转人工并留下工单。", starters: ["退货运费谁出", "发票怎么开"] },
  { k: "weekly", id: "weekly-report", n: "周报生成器", cat: "通用助手", by: "星河数据 周岚", v: 4, price: "约 2 积分/次", uses: "2.2 万次", d: "从日程、提交记录和聊天里汇总本周进展，生成可直接发出的周报。", starters: ["生成我这周的周报", "加上下周计划"] },
];
const CATS = ["全部", "通用助手", "研究分析", "内容创作", "开发工具", "办公运营"];

/* 工作室：「我的智能体」（含分享给我的） */
const MY_AGENTS = [
  { k: "expense-reviewer", id: "expense-reviewer", n: "报销审核助手", own: "mine", st: "v3，草稿有 4 处修改", tone: "warn", d: "读取发票和报销单，按公司制度做初审，超额提醒审批", runs7: 214, upd: "今天 14:32", contract: true },
  { k: "meeting", id: "meeting-notes", n: "会议纪要整理", own: "mine", st: "已发布 v5", tone: "ok", d: "上传录音或速记，整理出决议、待办和负责人", runs7: 1288, upd: "11-08", market: true },
  { k: "weekly", id: "weekly-report", n: "周报生成器", own: "mine", st: "已发布 v4", tone: "ok", d: "汇总本周进展，生成可直接发出的周报", runs7: 402, upd: "11-02", market: true },
  { k: "rival", id: "rival-weekly-draft", n: "竞品周报（新版）", own: "mine", st: "草稿，未发布", tone: "", d: "加入招聘动态与价格追踪", runs7: 6, upd: "昨天" },
  { k: "contract", id: "contract-diff", n: "合同条款比对", own: "shared-read", st: "分享给我，只读", tone: "", d: "比对两版合同的条款差异", runs7: 0, upd: "10-20", by: "法务部 罗婧" },
  { k: "currency", id: "fx-helper", n: "汇率换算", own: "shared-write", st: "分享给我，可编辑", tone: "", d: "按开票日查询汇率并换算", runs7: 31, upd: "10-30", by: "财务部 钱晓" },
  { k: "default", id: "default", n: "通用助手", own: "builtin", st: "内置，已发布", tone: "ok", d: "平台内置的通用对话智能体", runs7: 96, upd: "—" },
];

/* 对话：会话 */
const SESSIONS = [
  { id: "s1", k: "expense-reviewer", t: "这批 11 月差旅报销能过吗？", at: "14:20", turns: 6, run: true, g: "今天" },
  { id: "s2", k: "meeting", t: "整理周三项目例会", at: "11:05", turns: 3, g: "今天" },
  { id: "s3", k: "sql", t: "上月各部门报销总额", at: "昨天", turns: 4, g: "昨天" },
  { id: "s4", k: "expense-reviewer", t: "外币发票怎么换算", at: "昨天", turns: 2, g: "昨天" },
  { id: "s5", k: "contract", t: "比对两版采购合同", at: "11-07", turns: 5, g: "更早" },
  { id: "s6", k: "weekly", t: "第 45 周周报", at: "11-07", turns: 2, g: "更早" },
  { id: "s7", k: "kb", t: "退货运费谁出", at: "11-03", turns: 1, g: "更早", archived: true },
  { id: "s8", k: "expense-reviewer", t: "10 月差旅报销初审", at: "10-31", turns: 4, g: "更早", archived: true },
];

const USER = { name: "林舟", email: "linzhou@xinghe.example", role: "普通账号", face: "舟", credits: "12,480", frozen: "120", month: "1,862" };
const ADMIN = { name: "周岚", email: "zhoulan@xinghe.example", role: "管理员", face: "岚", credits: "8,200", frozen: "0", month: "3,410" };

/* ---------- 跨页演示状态（localStorage） ---------- */
const OWA = {
  handlers: {},
  on(name, fn) { this.handlers[name] = fn; },
  get admin() { return localStorage.getItem("owa.proto.role") === "admin" || /admin-/.test(location.pathname); },
  me() { return this.admin ? ADMIN : USER; },
  st: {
    _k: "owa.proto.state",
    _d: { evalPass: false, version: 3, changes: 4, keyIssued: false },
    all() { try { return { ...this._d, ...JSON.parse(localStorage.getItem(this._k) || "{}") }; } catch { return { ...this._d }; } },
    get(k) { return this.all()[k]; },
    set(k, v) { const a = this.all(); a[k] = v; localStorage.setItem(this._k, JSON.stringify(a)); },
    reset() { localStorage.removeItem(this._k); },
  },
};

/* ---------- 页面目录（顶栏、⌘K、原型目录共用） ---------- */
const PAGES = [
  // [分组, 名称, 文件, 关键词, 仅管理员]
  ["探索", "探索首页", "explore.html", "市场 发现 首页"],
  ["探索", "智能体详情 / 会议纪要整理", "market-detail.html", "详情 市场"],
  ["对话", "对话", "chat.html", "会话 工作台"],
  ["工作室", "我的智能体", "studio.html", "工作室 新建"],
  ["工作室", "报销审核助手 / 编排", "build.html#orch", "构建 配置 提示词"],
  ["工作室", "报销审核助手 / 评测", "build.html#eval", "评测 用例"],
  ["工作室", "报销审核助手 / 发布", "build.html#pub", "发布 上线清单 版本"],
  ["工作室", "报销审核助手 / 接入", "build.html#acc", "接入 调用 Key"],
  ["工作室", "报销审核助手 / 运行", "build.html#run", "运行记录 分析"],
  ["开发者", "API Key 与签名密钥", "dev-keys.html", "key 密钥 webhook 签名"],
  ["开发者", "运行记录", "dev-runs.html", "运行 记录"],
  ["账户", "积分与套餐", "account-billing.html", "积分 余额 充值 订单 流水 消耗"],
  ["账户", "用量分析", "account-usage.html", "用量 token"],
  ["账户", "模型价格", "account-prices.html", "价格 模型 算力"],
  ["账户", "账号安全", "account-security.html", "密码"],
  ["账户", "操作日志", "account-audit.html", "审计 日志"],
  ["平台管理", "账号", "admin-accounts.html", "账号 用户", true],
  ["平台管理", "模型与提供者", "admin-models.html", "模型 提供者 路由 别名", true],
  ["平台管理", "市场上架", "admin-market.html", "上架 下架", true],
  ["平台管理", "套餐与订单", "admin-packages.html", "套餐 订单", true],
  ["平台管理", "计费", "admin-billing.html", "计费 对账 发放 积分", true],
  ["平台管理", "平台运行与用量", "admin-ops.html", "运行 用量 审计", true],
];

/* ---------- 顶栏 ---------- */
const NAV = [
  ["explore", "探索", "explore.html"],
  ["chat", "对话", "chat.html"],
  ["studio", "工作室", "studio.html"],
  ["dev", "开发者", "dev-keys.html"],
  ["account", "账户", "account-billing.html"],
];
function brand() {
  return `<a class="brand navlink" href="explore.html"><svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="13" fill="#1C1C1C"/><rect x="9" y="9" width="3.4" height="9" rx="1.7" fill="#fff"/><rect x="15.6" y="9" width="3.4" height="9" rx="1.7" fill="#fff"/></svg>Open Web Agents</a>`;
}
function topnav(active) {
  const me = OWA.me();
  const items = OWA.admin ? [...NAV, ["admin", "管理", "admin-accounts.html"]] : NAV;
  return `<nav class="topnav">
    ${brand()}
    <div class="navs">${items.map(([k, n, h]) => `<a href="${h}" class="${k === active ? "on" : ""}" ${k === active ? 'aria-current="page"' : ""}>${n}</a>`).join("")}</div>
    <div class="nav-r">
      <button class="credit" data-a="owa-palette" title="搜索页面、智能体与会话">${ic("search", 16)}<span class="muted">搜索</span><span class="kbd">⌘K</span></button>
      <a class="credit navlink" href="account-billing.html" title="积分与套餐">${ic("coin", 16)}<b>${me.credits}</b><span class="muted">积分</span></a>
      <button class="me" data-a="owa-me" aria-label="账号菜单"><span>${me.name}</span><span class="face">${me.face}</span></button>
    </div>
  </nav>`;
}
function meMenu(btn) {
  closeMenus();
  const me = OWA.me();
  const r = btn.getBoundingClientRect();
  const m = document.createElement("div");
  m.className = "menu";
  m.style.cssText = `top:${r.bottom + 8}px;right:${innerWidth - r.right}px;position:fixed`;
  m.innerHTML = `<div class="mh2"><div style="font-weight:600">${me.name}</div><div class="muted small">${me.email}</div><span class="tag ${OWA.admin ? "dark" : ""}" style="margin-top:6px">${me.role}</span></div>
    <a href="account-billing.html">${ic("coin", 16)}积分与套餐<span class="muted small" style="margin-left:auto">${me.credits}</span></a>
    <a href="account-security.html">${ic("lock", 16)}账号安全</a>
    <a href="account-audit.html">${ic("audit", 16)}操作日志</a>
    ${OWA.admin ? `<a href="admin-accounts.html">${ic("shield", 16)}平台管理</a>` : ""}
    <hr><button data-a="owa-role">${ic("users", 16)}原型：切换为${OWA.admin ? "普通账号" : "管理员"}视角</button>
    <a href="login.html">${ic("logout", 16)}登出</a>`;
  document.body.appendChild(m);
}
function closeMenus() { $$(".menu").forEach((x) => x.remove()); }

/* ---------- ⌘K 跳转面板 ---------- */
function palette(open = true) {
  let p = $("#palette");
  if (!p) {
    p = document.createElement("div");
    p.id = "palette";
    p.innerHTML = `<div class="pbox"><input id="pal-q" placeholder="搜索页面、智能体、会话…" autocomplete="off"><div class="pl" id="pal-l"></div></div>`;
    document.body.appendChild(p);
    p.addEventListener("click", (e) => { if (e.target === p) palette(false); });
    $("#pal-q").addEventListener("input", renderPal);
    $("#pal-q").addEventListener("keydown", (e) => {
      const its = $$("#pal-l .pi"); let i = its.findIndex((x) => x.classList.contains("sel"));
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); its[i]?.classList.remove("sel"); i = (i + (e.key === "ArrowDown" ? 1 : -1) + its.length) % its.length; its[i]?.classList.add("sel"); }
      if (e.key === "Enter" && its[i]) location.href = its[i].getAttribute("href");
      if (e.key === "Escape") palette(false);
    });
  }
  p.classList.toggle("on", open);
  if (open) { $("#pal-q").value = ""; renderPal(); setTimeout(() => $("#pal-q").focus(), 10); }
}
function renderPal() {
  const q = $("#pal-q").value.trim();
  const hit = (s) => !q || s.toLowerCase().includes(q.toLowerCase());
  const groups = {};
  const add = (g, html) => (groups[g] = groups[g] || []).push(html);
  add("操作", `<a class="pi" href="studio.html#new">${ic("plus", 16)}新建智能体<span class="k">工作室</span></a>`);
  add("操作", `<a class="pi" href="chat.html#new">${ic("chat", 16)}新会话<span class="k">对话</span></a>`);
  PAGES.filter((p) => (!p[4] || OWA.admin) && hit(p[1] + p[3] + p[0])).forEach((p) => add("页面", `<a class="pi" href="${p[2]}">${ic("chev", 14)}${p[1]}<span class="k">${p[0]}</span></a>`));
  MY_AGENTS.filter((a) => hit(a.n + a.id)).forEach((a) => add("智能体", `<a class="pi" href="build.html?agent=${a.id}">${av(a.k, 22)}${a.n}<span class="k">${a.st}</span></a>`));
  SESSIONS.filter((s) => !s.archived && hit(s.t)).forEach((s) => add("会话", `<a class="pi" href="chat.html?session=${s.id}">${av(s.k, 22)}${s.t}<span class="k">${s.turns} 轮</span></a>`));
  const order = q ? ["页面", "智能体", "会话", "操作"] : ["操作", "页面", "智能体", "会话"];
  const html = order.filter((g) => groups[g]).map((g) => `<div class="pg">${g}</div>${groups[g].slice(0, q ? 20 : 6).join("")}`).join("");
  $("#pal-l").innerHTML = html || `<div class="empty-state muted">没有匹配「${esc(q)}」的页面、智能体或会话</div>`;
  $("#pal-l .pi")?.classList.add("sel");
}

/* ---------- toast / modal / drawer ---------- */
function toast(msg, ok = true) {
  const t = document.createElement("div");
  t.className = "t";
  t.innerHTML = (ok ? ic("check", 16, 2.2) : ic("warn", 16)) + `<span>${msg}</span>`;
  $("#toast").appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
function openModal(html, w = 520) {
  const m = $("#modal");
  m.querySelector(".box").style.width = w + "px";
  m.querySelector(".box").innerHTML = html;
  m.classList.add("on");
}
function closeModal() { $("#modal").classList.remove("on"); }
/** 确认弹窗：danger=true 时主按钮为危险样式 */
function confirmBox({ title, body, ok = "确定", danger = false, onOk }) {
  openModal(`<h3>${title}</h3><div style="margin-top:8px">${body}</div><div class="mfoot"><button class="btn ghost" data-a="owa-close">取消</button><button class="btn ${danger ? "danger" : ""}" id="cf-ok">${ok}</button></div>`, 460);
  $("#cf-ok").onclick = () => { closeModal(); onOk && onOk(); };
}
function openDrawer(html, w = 440) {
  closeDrawer();
  const d = document.createElement("aside");
  d.className = "drawer";
  d.id = "owa-drawer";
  d.style.width = w + "px";
  d.innerHTML = html;
  $("#app").appendChild(d);
}
function closeDrawer() { $("#owa-drawer")?.remove(); }

/* ---------- 侧栏（开发者 / 账户 / 平台管理） ---------- */
const SIDES = {
  dev: [["开发者", [["dev-keys.html", "API Key 与签名密钥", "key"], ["dev-runs.html", "运行记录", "pulse"]]]],
  account: [["积分", [["account-billing.html", "积分与套餐", "coin"], ["account-usage.html", "用量分析", "chart"], ["account-prices.html", "模型价格", "receipt"]]], ["账号", [["account-security.html", "账号安全", "lock"], ["account-audit.html", "操作日志", "audit"]]]],
  admin: [["平台管理", [["admin-accounts.html", "账号", "users"], ["admin-models.html", "模型与提供者", "cpu"], ["admin-market.html", "市场上架", "store"], ["admin-packages.html", "套餐与订单", "box"], ["admin-billing.html", "计费", "coin"], ["admin-ops.html", "平台运行与用量", "pulse"]]]],
};
function sideNav(kind) {
  const here = location.pathname.split("/").pop();
  return `<aside class="side">${SIDES[kind].map(([g, its]) => `<div class="g">${g}</div>${its.map(([h, n, i]) => `<a href="${h}" class="${h === here ? "on" : ""}" ${h === here ? 'aria-current="page"' : ""}>${ic(i, 17)}${n}</a>`).join("")}`).join('<div style="height:10px"></div>')}</aside>`;
}

/* ---------- 挂载 ---------- */
OWA.mount = function ({ nav, body }) {
  const app = $("#app") || Object.assign(document.body.appendChild(document.createElement("div")), { id: "app" });
  app.innerHTML = (nav === false ? "" : topnav(nav)) + body;
  if (!$("#modal")) document.body.insertAdjacentHTML("beforeend", '<div id="modal"><div class="box"></div></div><div id="toast"></div>');
  if (!$("#proto-fab")) document.body.insertAdjacentHTML("beforeend", `<a id="proto-fab" href="index.html">${ic("grid", 13)}原型目录</a><button id="gap-fab" data-a="owa-gaps">${ic("sparkle", 13)}新增功能标注</button>`);
  document.body.classList.toggle("show-gaps", localStorage.getItem("owa.proto.gaps") === "1");
};

/* ---------- 全局事件 ---------- */
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-a]");
  if (!e.target.closest(".menu") && !(t && t.dataset.a === "owa-me")) closeMenus();
  if (e.target.id === "modal") closeModal();
  if (!t) return;
  const a = t.dataset.a;
  if (a === "owa-palette") return palette(true);
  if (a === "owa-me") return meMenu(t);
  if (a === "owa-close") return closeModal();
  if (a === "owa-drawer-close") return closeDrawer();
  if (a === "owa-role") { localStorage.setItem("owa.proto.role", OWA.admin ? "user" : "admin"); location.href = OWA.admin ? "explore.html" : "admin-accounts.html"; return; }
  if (a === "owa-gaps") { const on = !document.body.classList.contains("show-gaps"); document.body.classList.toggle("show-gaps", on); localStorage.setItem("owa.proto.gaps", on ? "1" : "0"); return; }
  if (a === "owa-toast") return toast(t.dataset.t || "已完成", t.dataset.bad !== "1");
  const h = OWA.handlers[a];
  if (h) h(t, e);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "k" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); palette(!$("#palette")?.classList.contains("on")); }
  if (e.key === "Escape") { closeModal(); closeMenus(); }
});
