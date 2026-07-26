// 端到端测试的最小 HTTP 客户端。
//
// 为什么要自己写:node 的 fetch 不管 cookie,而这里大半断言都是【登录态下的越权】——
// 没有会话隔离就测不出"B 能不能碰 A 的东西"。第三方 cookie 库对这点需求是杀鸡用牛刀。

const BASE = process.env.OWA_E2E_BASE_URL ?? "http://localhost:3000";

export interface Res<T = unknown> {
  status: number;
  body: T;
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
      // 非 JSON 响应(如嵌入脚本)保持原文
    }
    return { status: res.status, body: body as T };
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
  del<T = unknown>(p: string, h?: Record<string, string>) {
    return this.req<T>("DELETE", p, { headers: h });
  }
}

let seq = 0;
/** 注册一个全新的普通用户(非 admin —— 库里已有用户时新注册的都是 user)。 */
export async function newUser(tag: string): Promise<Client> {
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
