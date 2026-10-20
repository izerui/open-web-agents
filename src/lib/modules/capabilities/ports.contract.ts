import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { priceUsage } from "./domain/catalog";
import type { CapabilityRepo } from "./ports";
import { CapabilityConflict, DuplicateModelId } from "./ports";

export function capabilityContract(
  name: string,
  make: () => CapabilityRepo,
  /** 按提供者查重依赖提供者行存在(MySQL 要锁这一行) */
  ensureProvider: (id: string) => Promise<void> = async () => {},
) {
  describe(`capability versions: ${name}`, () => {
    const llm = (id: string, providerId: string, modelId: string) => ({
      id,
      name: "Model",
      kind: "llm" as const,
      modelId,
      acceptsImages: false,
      enabled: true,
      providerId,
      markupBp: 1000,
      costRates: [{ meter: "input_token" as const, units: "1000000", microCredits: "100" }],
      rates: [],
    });
    it("同一提供者下文本模型标识唯一;不同提供者、非文本类型可重复", async () => {
      const repo = make();
      const p1 = `p-${randomUUID().slice(0, 8)}`;
      const p2 = `p-${randomUUID().slice(0, 8)}`;
      await ensureProvider(p1);
      await ensureProvider(p2);
      const modelId = `m-${randomUUID()}`;
      const a = await repo.save(llm(`a-${randomUUID()}`, p1, modelId), null, "admin");
      expect(a.rates[0]?.microCredits).toBe("110");
      await expect(
        repo.save(llm(`b-${randomUUID()}`, p1, modelId), null, "admin"),
      ).rejects.toBeInstanceOf(DuplicateModelId);
      await expect(
        repo.save(llm(`c-${randomUUID()}`, p2, modelId), null, "admin"),
      ).resolves.toBeTruthy();
      await expect(repo.save({ ...a, name: "改名" }, 1, "admin")).resolves.toBeTruthy();
      const image = {
        name: "Image",
        kind: "image" as const,
        modelId,
        acceptsImages: false,
        enabled: true,
        providerId: p1,
        markupBp: 0,
        costRates: [{ meter: "image" as const, units: "1", microCredits: "1" }],
        rates: [],
      };
      await repo.save({ id: `i1-${randomUUID()}`, ...image }, null, "admin");
      await expect(
        repo.save({ id: `i2-${randomUUID()}`, ...image }, null, "admin"),
      ).resolves.toBeTruthy();
    });
    it("并发新建同一提供者、同一标识的文本模型,只有一个成功", async () => {
      const repo = make();
      const p = `p-${randomUUID().slice(0, 8)}`;
      await ensureProvider(p);
      const modelId = `m-${randomUUID()}`;
      const outcomes = await Promise.allSettled([
        repo.save(llm(`x-${randomUUID()}`, p, modelId), null, "admin"),
        repo.save(llm(`y-${randomUUID()}`, p, modelId), null, "admin"),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(DuplicateModelId);
    });
    it("retire:停用并记下替代者、追加版本、保留历史;重复执行不再变化", async () => {
      const repo = make();
      const id = `model-${randomUUID()}`;
      await repo.save(
        {
          id,
          name: "Old",
          kind: "llm",
          modelId: `m-${randomUUID()}`,
          enabled: true,
          acceptsImages: false,
          rates: [{ meter: "input_token", units: "1000", microCredits: "7" }],
        },
        null,
        "admin",
      );
      await repo.retire(id, "new-model", "system");
      await repo.retire(id, "other-model", "system");
      expect(await repo.get(id)).toMatchObject({
        enabled: false,
        replacedBy: "new-model",
        version: 2,
      });
      expect((await repo.version(id, 1))?.enabled).toBe(true);
      expect((await repo.version(id, 2))?.createdBy).toBe("system");
      expect((await repo.list()).some((c) => c.id === id)).toBe(false);
      await expect(repo.retire(`missing-${id}`, "x", "system")).resolves.toBeUndefined();
    });
    it("new prices never change the immutable quote used by older calls", async () => {
      const repo = make();
      const id = `model-${randomUUID()}`;
      const first = await repo.save(
        {
          id,
          name: "Model",
          kind: "llm",
          modelId: "real-model",
          acceptsImages: true,
          enabled: true,
          rates: [{ meter: "input_token", units: "1000", microCredits: "1000000" }],
        },
        null,
        "admin",
      );
      await repo.save(
        {
          ...first,
          rates: [{ meter: "input_token", units: "1000", microCredits: "2000000" }],
        },
        1,
        "admin",
      );
      const old = await repo.version(id, 1);
      const current = await repo.get(id);
      expect(old?.version).toBe(1);
      expect(current?.version).toBe(2);
      expect(priceUsage(old?.rates ?? [], { input_token: "1000" }).microCredits).toBe("1000000");
      expect(priceUsage(current?.rates ?? [], { input_token: "1000" }).microCredits).toBe(
        "2000000",
      );
      await expect(repo.save(first, 1, "admin")).rejects.toBeInstanceOf(CapabilityConflict);
    });
    it("concurrent edits cannot silently replace each other", async () => {
      const repo = make();
      const definition = {
        id: `model-${randomUUID()}`,
        name: "Model",
        kind: "llm" as const,
        modelId: "real",
        acceptsImages: false,
        enabled: false,
        rates: [],
      };
      await repo.save(definition, null, "admin");
      const outcomes = await Promise.allSettled([
        repo.save({ ...definition, name: "A" }, 1, "admin"),
        repo.save({ ...definition, name: "B" }, 1, "admin"),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await repo.get(definition.id))?.version).toBe(2);
    });
    it("disabled capabilities are absent from the public catalog, history remains readable", async () => {
      const repo = make();
      const saved = await repo.save(
        {
          id: `model-${randomUUID()}`,
          name: "Model",
          kind: "image",
          modelId: "image-model",
          enabled: true,
          acceptsImages: false,
          rates: [{ meter: "image", units: "1", microCredits: "10" }],
        },
        null,
        "admin",
      );
      await repo.save({ ...saved, enabled: false }, 1, "admin");
      expect((await repo.list()).some((c) => c.id === saved.id)).toBe(false);
      expect((await repo.list(true)).some((c) => c.id === saved.id)).toBe(true);
      expect((await repo.version(saved.id, 1))?.enabled).toBe(true);
    });
  });
}
