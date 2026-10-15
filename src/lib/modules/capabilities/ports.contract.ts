import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { priceUsage } from "./domain/catalog";
import type { CapabilityRepo } from "./ports";
import { CapabilityConflict } from "./ports";

export function capabilityContract(name: string, make: () => CapabilityRepo) {
  describe(`capability versions: ${name}`, () => {
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
