import { changedFields, sanitizeDetails } from "@/lib/modules/audit/domain/events";
import { describe, expect, it } from "vitest";

describe("sanitizeDetails", () => {
  it("字段名像机密的一律打码,以 Id 结尾的不算", () => {
    expect(
      sanitizeDetails({
        apiKey: "sk-1",
        password: "p",
        webhookSecret: "s",
        token: "t",
        env: { A: "1" },
        Authorization: "Bearer x",
        plaintext: "owa_abc",
        systemPrompt: "内部提示词",
        keyId: "k1",
        agentId: "a1",
        name: "正常",
      }),
    ).toEqual({
      apiKey: "***",
      password: "***",
      webhookSecret: "***",
      token: "***",
      env: "***",
      Authorization: "***",
      plaintext: "***",
      systemPrompt: "***",
      keyId: "k1",
      agentId: "a1",
      name: "正常",
    });
  });

  it("嵌套对象同样处理;长字符串截断;深度封顶", () => {
    const out = sanitizeDetails({
      outer: { secret: "x", text: "a".repeat(600) },
      deep: { a: { b: { c: { d: 1 } } } },
    }) as { outer: { secret: string; text: string }; deep: unknown };
    expect(out.outer.secret).toBe("***");
    expect(out.outer.text.length).toBe(501);
    expect(JSON.stringify(out.deep)).toContain("[…]");
  });
});

describe("changedFields", () => {
  it("只给字段名;键顺序不同不算修改;新增与删除都算", () => {
    expect(
      changedFields(
        { a: 1, b: { x: 1, y: 2 }, c: "keep", gone: true },
        { a: 2, b: { y: 2, x: 1 }, c: "keep", added: 1 },
      ),
    ).toEqual(["a", "added", "gone"]);
    expect(changedFields(undefined, { a: 1 })).toEqual(["a"]);
  });
});
