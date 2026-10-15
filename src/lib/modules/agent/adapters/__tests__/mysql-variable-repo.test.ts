import { randomUUID } from "node:crypto";
import { createDb } from "@/lib/db/client";
import { agentVariables } from "@/lib/db/schema";
import {
  MysqlVariableRepo,
  VariableDecryptionFailed,
  VariableSizeExceeded,
} from "@/lib/modules/agent/adapters/mysql-variable-repo";
import { SecretBox } from "@/lib/modules/identity/domain/secret-box";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const url = process.env.OWA_TEST_DATABASE_URL;
if (!url) {
  describe.skip("MysqlVariableRepo (requires owa_test)", () => {
    it("not configured", () => {});
  });
} else {
  const { db, pool } = createDb(url);
  const secrets = new SecretBox("test-key-for-variable-repo");
  const repo = new MysqlVariableRepo(db, secrets);
  const pairs: [string, string][] = [];

  afterAll(async () => {
    try {
      for (const [agentId, userId] of pairs) {
        await db
          .delete(agentVariables)
          .where(eq(agentVariables.agentId, agentId))
          .catch(() => {});
      }
    } finally {
      await pool.end();
    }
  });

  describe("MysqlVariableRepo", () => {
    it("round-trips a large value through encryption and decryption", async () => {
      const agentId = `var-test-${randomUUID().slice(0, 16)}`;
      const userId = `user-${randomUUID().slice(0, 16)}`;
      pairs.push([agentId, userId]);

      const largeValue = "x".repeat(3500);
      const values = {
        SHORT_KEY: "sk-abc123",
        LONG_KEY: largeValue,
        ANOTHER: "some-value",
      };

      await repo.set(agentId, userId, values);
      const read = await repo.get(agentId, userId);
      expect(read.SHORT_KEY).toBe("sk-abc123");
      expect(read.LONG_KEY).toBe(largeValue);
      expect(read.LONG_KEY).toHaveLength(3500);
      expect(read.ANOTHER).toBe("some-value");
    });

    it("returns empty object for nonexistent agent/user pair", async () => {
      expect(await repo.get("nonexistent", "nobody")).toEqual({});
    });

    it("overwrites previous values on set", async () => {
      const agentId = `var-test-${randomUUID().slice(0, 16)}`;
      const userId = `user-${randomUUID().slice(0, 16)}`;
      pairs.push([agentId, userId]);

      await repo.set(agentId, userId, { A: "1", B: "2" });
      await repo.set(agentId, userId, { A: "updated", C: "3" });
      const read = await repo.get(agentId, userId);
      expect(read).toEqual({ A: "updated", C: "3" });
      expect(read.B).toBeUndefined();
    });

    it("deletes variable values", async () => {
      const agentId = `var-test-${randomUUID().slice(0, 16)}`;
      const userId = `user-${randomUUID().slice(0, 16)}`;
      pairs.push([agentId, userId]);

      await repo.set(agentId, userId, { K: "v" });
      await repo.delete(agentId, userId);
      expect(await repo.get(agentId, userId)).toEqual({});
    });

    it("isolates values between users for the same agent", async () => {
      const agentId = `var-test-${randomUUID().slice(0, 16)}`;
      const userA = `user-a-${randomUUID().slice(0, 12)}`;
      const userB = `user-b-${randomUUID().slice(0, 12)}`;
      pairs.push([agentId, userA], [agentId, userB]);

      await repo.set(agentId, userA, { KEY: "a-secret" });
      await repo.set(agentId, userB, { KEY: "b-secret" });
      expect((await repo.get(agentId, userA)).KEY).toBe("a-secret");
      expect((await repo.get(agentId, userB)).KEY).toBe("b-secret");
    });

    it("concurrent merge of different keys preserves both", async () => {
      const agentId = `var-test-${randomUUID().slice(0, 16)}`;
      const userId = `user-${randomUUID().slice(0, 16)}`;
      pairs.push([agentId, userId]);

      await repo.set(agentId, userId, { EXISTING: "base" });

      const results = await Promise.all([
        repo.merge(agentId, userId, { KEY_A: "value-a" }),
        repo.merge(agentId, userId, { KEY_B: "value-b" }),
      ]);

      const final = await repo.get(agentId, userId);
      expect(final.EXISTING).toBe("base");
      expect(final.KEY_A).toBe("value-a");
      expect(final.KEY_B).toBe("value-b");
    });

    it("merge with null deletes a key without affecting others", async () => {
      const agentId = `var-test-${randomUUID().slice(0, 16)}`;
      const userId = `user-${randomUUID().slice(0, 16)}`;
      pairs.push([agentId, userId]);

      await repo.set(agentId, userId, { A: "1", B: "2", C: "3" });
      await repo.merge(agentId, userId, { B: null, D: "4" });

      const final = await repo.get(agentId, userId);
      expect(final).toEqual({ A: "1", C: "3", D: "4" });
    });

    it("merge with wrong secret key throws and leaves original ciphertext unchanged", async () => {
      const agentId = `var-test-${randomUUID().slice(0, 16)}`;
      const userId = `user-${randomUUID().slice(0, 16)}`;
      pairs.push([agentId, userId]);

      await repo.set(agentId, userId, { SECRET: "important-value", OTHER: "keep" });

      const wrongKeyRepo = new MysqlVariableRepo(
        db,
        new SecretBox("wrong-key-completely-different"),
      );
      await expect(wrongKeyRepo.merge(agentId, userId, { NEW: "val" })).rejects.toThrow(
        VariableDecryptionFailed,
      );

      const intact = await repo.get(agentId, userId);
      expect(intact.SECRET).toBe("important-value");
      expect(intact.OTHER).toBe("keep");
    });

    it("merge exceeding size limit throws and leaves original values unchanged", async () => {
      const agentId = `var-test-${randomUUID().slice(0, 16)}`;
      const userId = `user-${randomUUID().slice(0, 16)}`;
      pairs.push([agentId, userId]);

      await repo.set(agentId, userId, { ORIGINAL: "preserved" });

      const hugeUpdates: Record<string, string> = {};
      for (let i = 0; i < 200; i++) hugeUpdates[`K${i}`] = "x".repeat(3000);

      await expect(repo.merge(agentId, userId, hugeUpdates)).rejects.toThrow(VariableSizeExceeded);

      const intact = await repo.get(agentId, userId);
      expect(intact.ORIGINAL).toBe("preserved");
      expect(intact.K0).toBeUndefined();
    });
  });
}
