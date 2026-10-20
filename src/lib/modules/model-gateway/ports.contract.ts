import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type ModelAliasRepo, ProviderConflict, type ProviderRepo } from "./ports";

export function providerContract(
  name: string,
  make: () => { providers: ProviderRepo; aliases: ModelAliasRepo },
) {
  describe(`model providers: ${name}`, () => {
    const def = (id: string, providerName = `提供者-${id}`) => ({
      id,
      name: providerName,
      enabled: true,
      endpoints: { llm: { protocol: "anthropic", baseUrl: "https://api.example.com/" } },
    });

    it("新建、读取、接入地址规范化;新建时不能覆盖已有提供者", async () => {
      const { providers } = make();
      const id = `p-${randomUUID().slice(0, 8)}`;
      const saved = await providers.save(def(id), null, "admin");
      expect(saved).toMatchObject({ id, version: 1, hasKey: false, keyHint: null });
      expect(saved.endpoints.llm?.baseUrl).toBe("https://api.example.com");
      expect((await providers.get(id))?.name).toBe(`提供者-${id}`);
      expect((await providers.list()).some((p) => p.id === id)).toBe(true);
      await expect(providers.save(def(id), null, "admin")).rejects.toBeInstanceOf(ProviderConflict);
    });

    it("名称唯一", async () => {
      const { providers } = make();
      const name = `同名-${randomUUID()}`;
      await providers.save(def(`p-${randomUUID().slice(0, 8)}`, name), null, "admin");
      await expect(
        providers.save(def(`p-${randomUUID().slice(0, 8)}`, name), null, "admin"),
      ).rejects.toThrow(/名称/);
    });

    it("并发修改只有一个成功", async () => {
      const { providers } = make();
      const id = `p-${randomUUID().slice(0, 8)}`;
      await providers.save(def(id), null, "admin");
      const outcomes = await Promise.allSettled([
        providers.save({ ...def(id), name: `A-${id}` }, 1, "admin"),
        providers.save({ ...def(id), name: `B-${id}` }, 1, "admin"),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await providers.get(id))?.version).toBe(2);
    });

    it("替换 Key 只换密文与掩码,不改版本号;列表不含密文", async () => {
      const { providers } = make();
      const id = `p-${randomUUID().slice(0, 8)}`;
      await providers.save(def(id), null, "admin");
      await providers.setKey(id, "v1$cipher", "****abcd", "admin");
      const p = await providers.get(id);
      expect(p).toMatchObject({ hasKey: true, keyHint: "****abcd", version: 1 });
      expect(JSON.stringify(p)).not.toContain("cipher");
      expect(JSON.stringify(await providers.list())).not.toContain("cipher");
      expect(await providers.keyEnc(id)).toBe("v1$cipher");
      await expect(providers.setKey(`missing-${id}`, "x", "y", "admin")).rejects.toThrow();
    });

    it("别名映射:首次新建、按版本修改、过期版本冲突", async () => {
      const { aliases } = make();
      const current = await aliases.get();
      const map = {
        providerId: "platform-default",
        fable: "m-a",
        opus: "m-a",
        sonnet: "m-b",
        haiku: "m-c",
      };
      const saved = await aliases.save(map, current?.version ?? null, "admin");
      expect(saved).toMatchObject({ ...map, version: (current?.version ?? 0) + 1 });
      await expect(aliases.save(map, current?.version ?? null, "admin")).rejects.toBeInstanceOf(
        ProviderConflict,
      );
      expect((await aliases.get())?.sonnet).toBe("m-b");
      // 别名映射全库只有一行:共享的测试库还有服务在用,改完要写回原值
      if (current) {
        const { version: _v, updatedAt: _u, ...original } = current;
        await aliases.save(original, saved.version, "admin");
      }
    });
  });
}
