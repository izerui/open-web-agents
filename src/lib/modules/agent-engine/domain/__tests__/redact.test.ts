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
