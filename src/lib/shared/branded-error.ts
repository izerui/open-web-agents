// 跨模块副本也能正确 instanceof 的错误基类。
//
// 【为什么需要】Next 把同一个源文件分别打进"页面"和"接口路由"两套模块图,同一个错误类
// 在运行时有两份。容器缓存在 globalThis 上,由先加载的那一份创建:服务启动后第一个请求
// 若是页面,容器里的服务抛出的是页面那份 AuthError / Forbidden,接口路由里的
// `err instanceof AuthError` 比对的却是路由这份 —— 判定失败,本该 401/403/404 的请求
// 一律变成 500,直到进程重启。e2e 的就绪探针先打 /api/health,所以一直没测出来。
//
// 做法:每个类用 Symbol.for 登记一个全局唯一的"品牌",实例在构造时记下继承链上所有品牌,
// instanceof 改为查品牌而不是原型链。两份副本拿到的是同一个 Symbol,判定一致。
//
// 子类必须声明自己的 static brand,否则会继承父类的品牌,`instanceof 子类` 会误认父类实例
// (见 __tests__/branded-error.test.ts 里对所有子类的检查)。

const BRANDS = Symbol.for("owa.error.brands");

type Branded = { [BRANDS]?: Set<symbol> };

export class BrandedError extends Error {
  static readonly brand: symbol = Symbol.for("owa.error.BrandedError");

  static [Symbol.hasInstance](v: unknown): boolean {
    if (typeof v !== "object" || v === null) return false;
    // 必须用 this:`x instanceof Forbidden` 调到继承来的这个方法时 this 是 Forbidden,
    // 要比对 Forbidden 自己的品牌;写死类名就只能判定基类
    // biome-ignore lint/complexity/noThisInStatic: 见上
    return (v as Branded)[BRANDS]?.has(this.brand) === true;
  }

  constructor(message?: string) {
    super(message);
    const brands = new Set<symbol>();
    // 沿构造器链收集品牌:new.target 是实际构造的子类
    let c: unknown = new.target;
    while (typeof c === "function" && "brand" in c) {
      brands.add((c as { brand: symbol }).brand);
      c = Object.getPrototypeOf(c);
    }
    Object.defineProperty(this, BRANDS, { value: brands, enumerable: false });
    this.name = new.target.name;
  }
}
