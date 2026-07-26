import { redactInput, redactSecrets } from "@/lib/modules/agent-engine/domain/redact";
import { describe, expect, it } from "vitest";

describe("redactSecrets", () => {
  it("掩码 *_KEY= 赋值但保留变量名", () => {
    expect(redactSecrets("FOO_KEY=sk-abcdefgh run")).toBe("FOO_KEY=*** run");
  });
  it("掩码带引号的值并保留引号", () => {
    expect(redactSecrets('MY_TOKEN="topsecretvalue"')).toBe('MY_TOKEN="***"');
  });
  it("掩码裸 sk- 密钥", () => {
    expect(redactSecrets("use sk-abcdefghij here")).toBe("use sk-*** here");
  });
  it("多个密钥全部掩码", () => {
    expect(redactSecrets("A_KEY=v1 B_SECRET=v2")).toBe("A_KEY=*** B_SECRET=***");
  });
  it("大小写不敏感", () => {
    expect(redactSecrets("my_password=abc")).toBe("my_password=***");
  });
  it("干净文本原样返回", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
  });
  it("空串安全", () => {
    expect(redactSecrets("")).toBe("");
  });
});

// 值一律按 `[^\s"']+` 匹配,跨不过空格 —— 引号里带空格的密码【一个字符都没打码】,
// 明文经事件流推给每个 SSE 订阅者,并进重放缓冲。
// 这个模块存在的唯一目的就是阻止这件事,却恰好在最该防的写法上失效;
// 而上面那组用例的值全是无空格串,所以从没暴露。
describe("redactSecrets / 【空格回归】引号内含空格的密钥", () => {
  const cases: [string, string][] = [
    ['export DB_PASSWORD="p@ss w0rd" && run', 'export DB_PASSWORD="***" && run'],
    ["API_KEY='abc def' python x.py", "API_KEY='***' python x.py"],
    ['OSS_ACCESS_KEY_SECRET="a b c" ossutil cp', 'OSS_ACCESS_KEY_SECRET="***" ossutil cp'],
    ['MYSQL_PASSWORD="a b" mysql -e "select 1"', 'MYSQL_PASSWORD="***" mysql -e "select 1"'],
  ];
  for (const [input, expected] of cases) {
    it(input, () => expect(redactSecrets(input)).toBe(expected));
  }

  it("不带引号的值仍按空格断开 —— 命令后续参数不该被一起吞掉", () => {
    expect(redactSecrets("API_KEY=abcdef123 python x.py")).toBe("API_KEY=*** python x.py");
  });

  it("绝不把原始密钥片段留在输出里", () => {
    const out = redactSecrets('AWS_SECRET_ACCESS_KEY="wJalr UtnFEMI K7MDENG" aws s3 ls');
    expect(out).not.toContain("wJalr");
    expect(out).not.toContain("K7MDENG");
    expect(out).toContain("aws s3 ls");
  });
});

describe("redactInput", () => {
  it("递归掩码对象里的字符串", () => {
    expect(redactInput({ cmd: "X_TOKEN=sk-xxxxxxxx python" })).toEqual({
      cmd: "X_TOKEN=*** python",
    });
  });
  it("递归掩码嵌套结构", () => {
    expect(redactInput({ a: { b: ["PASSWORD=hunter2secret"] } })).toEqual({
      a: { b: ["PASSWORD=***"] },
    });
  });
  it("非字符串原样返回", () => {
    expect(redactInput(42)).toBe(42);
    expect(redactInput(null)).toBe(null);
    expect(redactInput(true)).toBe(true);
  });
});
