// 端到端测试的最小 HTTP 客户端。
//
// 为什么要自己写:node 的 fetch 不管 cookie,而这里大半断言都是【登录态下的越权】——
// 没有会话隔离就测不出"B 能不能碰 A 的东西"。第三方 cookie 库对这点需求是杀鸡用牛刀。

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:5678";

export interface Res<T = unknown> {
  status: number;
  body: T;
  /** 响应头(限流等用例要断言 Retry-After / X-RateLimit-*) */
  headers: Headers;
}

/** 一个独立的浏览器身份:自带 cookie 罐,互不串味。 */
export class Client {
  private cookies = new Map<string, string>();

  constructor(readonly label: string) {}

  /** 当前 cookie 头。需要绕开本客户端直接发 fetch(如流式请求)时用得上。 */
  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorb(res: Response): void {
    // Node 18+ 提供 getSetCookie();多条 Set-Cookie 不能用 get() 读,会被合并成一条
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(";");
      const idx = pair?.indexOf("=") ?? -1;
      if (!pair || idx < 0) continue;
      this.cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
  }

  async req<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Res<T>> {
    const headers: Record<string, string> = { ...opts.headers };
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    this.absorb(res);

    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON 响应保持原文
    }
    return { status: res.status, body: body as T, headers: res.headers };
  }

  get<T = unknown>(p: string, h?: Record<string, string>) {
    return this.req<T>("GET", p, { headers: h });
  }
  post<T = unknown>(p: string, body?: unknown, h?: Record<string, string>) {
    return this.req<T>("POST", p, { body, headers: h });
  }
  put<T = unknown>(p: string, body?: unknown) {
    return this.req<T>("PUT", p, { body });
  }
  patch<T = unknown>(p: string, body?: unknown, h?: Record<string, string>) {
    return this.req<T>("PATCH", p, { body, headers: h });
  }
  del<T = unknown>(p: string, h?: Record<string, string>) {
    return this.req<T>("DELETE", p, { headers: h });
  }
}

/** 服务用的测试库(scripts/e2e.sh 导出;库名必须含 test) */
const TEST_DB = process.env.OWA_E2E_DATABASE_URL;
const fundable = Boolean(TEST_DB && /test/i.test(new URL(TEST_DB).pathname));

/**
 * 给测试账号直接在测试库里入账(只用于 e2e)。运行一律正式计费,余额不足会被拒绝(402),
 * 而 e2e 建不出管理员去走发放接口;产品本身没有新用户赠送。
 */
export async function fundTestAccount(accountId: string, credits: bigint): Promise<void> {
  if (!fundable || credits <= 0n) return;
  const { createDb } = await import("@/lib/db/client");
  const { MysqlBillingRepo } = await import("@/lib/modules/billing/adapters/mysql-billing-repo");
  const { db, pool } = createDb(TEST_DB as string);
  try {
    await new MysqlBillingRepo(db).credit({
      accountId,
      amountMicroCredits: (credits * 1_000_000n).toString(),
      idempotencyKey: `e2e-fund-${accountId}`,
      actorId: "e2e",
      reason: "E2E 测试账号入账",
    });
  } finally {
    await pool.end();
  }
}

let seq = 0;
/**
 * 注册一个全新的普通用户(非 admin —— 库里已有用户时新注册的都是 user)。
 * 有测试库时默认入账 10 万积分(每次运行冻结数百积分,并发用例也够用);要从零余额开始的用例传 `{ credits: 0n }`。
 */
export async function newUser(tag: string, opts: { credits?: bigint } = {}): Promise<Client> {
  const c = new Client(tag);
  const email = `e2e-${tag}-${Date.now()}-${seq++}@example.test`;
  const res = await c.post<{ user?: { id: string; role?: string } }>("/api/auth", {
    action: "register",
    email,
    password: "e2e-password-123456",
    name: tag,
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`注册失败(${res.status}):${JSON.stringify(res.body)}`);
  }
  const id = res.body.user?.id;
  if (id) await fundTestAccount(id, opts.credits ?? 100_000n);
  return c;
}

/** 服务是否起着 —— 没起就跳过整个 e2e 套件,并说清楚怎么起。 */
export async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health?probe=live`);
    return r.ok;
  } catch {
    return false;
  }
}

export { BASE };
