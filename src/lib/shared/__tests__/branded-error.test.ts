import { BrandedError } from "@/lib/shared";
import { describe, expect, it, vi } from "vitest";

/** 所有需要跨模块副本判定的错误类:模块路径 → 导出的类名 */
const ERROR_CLASSES: [string, string[]][] = [
  ["@/lib/modules/access/application/authorize", ["Unauthorized", "Forbidden"]],
  ["@/lib/modules/identity/application/auth-service", ["AuthError"]],
  ["@/lib/modules/usage/application/quota-guard", ["QuotaExceeded"]],
  ["@/lib/modules/agent/application/releases", ["VersionNotFound", "NothingToPublish"]],
  ["@/lib/modules/run/ports", ["DuplicateIdempotencyKey"]],
  ["@/lib/modules/run/application/enqueue", ["PromptTooLarge", "EnqueueTargetMissing"]],
  ["@/lib/modules/approval/ports", ["ApprovalUnavailable"]],
  ["@/lib/modules/artifacts/domain/safe-path", ["PathEscapeError"]],
  ["@/lib/modules/integration/application/webhook", ["WebhookTargetRejected"]],
];

type Cls = (new (...a: never[]) => Error) & { brand?: symbol };

async function load(mod: string): Promise<Record<string, Cls>> {
  return (await import(/* @vite-ignore */ mod)) as Record<string, Cls>;
}

describe("BrandedError", () => {
  it("同一模块被加载成两份(Next 的页面与路由两套模块图):实例仍能被另一份 instanceof 认出", async () => {
    vi.resetModules();
    const a = await load("@/lib/modules/identity/application/auth-service");
    vi.resetModules();
    const b = await load("@/lib/modules/identity/application/auth-service");
    const A = a.AuthError as Cls;
    const B = b.AuthError as Cls;
    expect(A).not.toBe(B); // 确实是两份类
    const err = new (A as unknown as new (m: string, s: number) => Error)("邮箱或密码不正确", 401);
    expect(err instanceof B).toBe(true);
    expect((err as unknown as { status: number }).status).toBe(401);

    vi.resetModules();
    const z1 = await load("@/lib/modules/access/application/authorize");
    vi.resetModules();
    const z2 = await load("@/lib/modules/access/application/authorize");
    const forbidden = new (z1.Forbidden as unknown as new (m: string) => Error)("no");
    expect(forbidden instanceof (z2.Forbidden as Cls)).toBe(true);
    // 兄弟类互不冒认
    expect(forbidden instanceof (z2.Unauthorized as Cls)).toBe(false);
  });

  it("每个错误类声明了自己的品牌(否则会继承父类品牌,互相冒认),且互不重复", async () => {
    const seen = new Set<symbol>();
    for (const [mod, names] of ERROR_CLASSES) {
      const m = await load(mod);
      for (const n of names) {
        const C = m[n] as Cls;
        expect(C, `${mod} 应导出 ${n}`).toBeTypeOf("function");
        expect(Object.hasOwn(C, "brand"), `${n} 须声明 static brand`).toBe(true);
        expect(C.brand).toBe(Symbol.for(`owa.error.${n}`));
        expect(seen.has(C.brand as symbol)).toBe(false);
        seen.add(C.brand as symbol);
        expect(Object.getPrototypeOf(C.prototype) instanceof Error).toBe(true);
      }
    }
  });

  it("保留普通 Error 的行为:message、name、stack、instanceof Error / 基类", () => {
    class Boom extends BrandedError {
      static readonly brand = Symbol.for("owa.error.test.Boom");
    }
    const e = new Boom("炸了");
    expect(e.message).toBe("炸了");
    expect(e.name).toBe("Boom");
    expect(e.stack).toContain("炸了");
    expect(e instanceof Error).toBe(true);
    expect(e instanceof BrandedError).toBe(true);
    expect(new Error("x") instanceof Boom).toBe(false);
    expect({} instanceof Boom).toBe(false);
    // 品牌不进 JSON / 枚举
    expect(Object.keys(e)).not.toContain("brands");
  });
});
