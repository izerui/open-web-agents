import { createDb } from "@/lib/db/client";
import {
  capabilityCatalog,
  capabilityVersions,
  modelAliases,
  modelProviders,
  platformState,
} from "@/lib/db/schema";
import { MysqlCapabilityRepo } from "@/lib/modules/capabilities/adapters/mysql-capability-repo";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OFFICIAL_MODEL_IDS } from "../../adapters/env-gateway";
import {
  MysqlBootstrapMarker,
  MysqlModelAliasRepo,
  MysqlProviderRepo,
} from "../../adapters/mysql-provider-repo";
import { BOOTSTRAP_KEY, bootstrapProviders } from "../bootstrap";

const url = process.env.OWA_TEST_DATABASE_URL;
if (!url) {
  describe.skip("bootstrap: MySQL requires OWA_TEST_DATABASE_URL", () => {
    it("requires test database", () => {});
  });
} else {
  if (!/test/i.test(new URL(url).pathname)) throw new Error("Dedicated test database required");
  // 两个独立连接池,模拟 web 与 worker 两个进程同时启动
  const a = createDb(url);
  const b = createDb(url);
  afterAll(async () => {
    await a.pool.end();
    await b.pool.end();
  });

  const depsOf = ({ db }: typeof a) => ({
    providers: new MysqlProviderRepo(db),
    aliases: new MysqlModelAliasRepo(db),
    capabilities: new MysqlCapabilityRepo(db),
    marker: new MysqlBootstrapMarker(db),
    encrypt: (p: string) => `enc(${p})`,
    mask: (p: string) => `****${p.slice(-4)}`,
    env: {
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-1234",
      slots: { ...OFFICIAL_MODEL_IDS },
    },
  });

  describe("bootstrap: MySQL", () => {
    // 别名映射全库只有一行,这里会清空重建:测完写回原值,不影响共用这个测试库的服务
    let original: Awaited<ReturnType<MysqlModelAliasRepo["get"]>> = null;
    beforeAll(async () => {
      original = await new MysqlModelAliasRepo(a.db).get();
    });
    afterAll(async () => {
      if (!original) return;
      const repo = new MysqlModelAliasRepo(a.db);
      const now = await repo.get();
      const { version: _v, updatedAt: _u, ...map } = original;
      await repo.save(map, now?.version ?? null, "test");
    });

    it("两个进程并发启动只生效一次", async () => {
      const { db } = a;
      // 专用测试库:清掉上一轮留下的平台默认数据
      await db.delete(platformState).where(eq(platformState.k, BOOTSTRAP_KEY));
      await db.delete(modelAliases);
      await db
        .delete(capabilityCatalog)
        .where(eq(capabilityCatalog.providerId, "platform-default"));
      await db.delete(capabilityVersions).where(like(capabilityVersions.capabilityId, "default-%"));
      await db.delete(modelProviders).where(eq(modelProviders.id, "platform-default"));

      await Promise.all([bootstrapProviders(depsOf(a)), bootstrapProviders(depsOf(b))]);

      const providers = await db
        .select()
        .from(modelProviders)
        .where(eq(modelProviders.id, "platform-default"));
      expect(providers).toHaveLength(1);
      const models = await db
        .select()
        .from(capabilityCatalog)
        .where(eq(capabilityCatalog.providerId, "platform-default"));
      const official = Object.values(OFFICIAL_MODEL_IDS) as string[];
      expect(
        models
          .filter((m) => official.includes(m.modelId))
          .map((m) => m.modelId)
          .sort(),
        JSON.stringify(models.map((m) => [m.id, m.modelId, m.version])),
      ).toEqual(Object.values(OFFICIAL_MODEL_IDS).sort());
      expect(models.filter((m) => official.includes(m.modelId)).every((m) => m.version === 1)).toBe(
        true,
      );
      const aliasRows = await db.select().from(modelAliases);
      expect(aliasRows).toHaveLength(1);
      expect(aliasRows[0]?.version).toBe(1);
      expect(await new MysqlBootstrapMarker(db).isDone(BOOTSTRAP_KEY)).toBe(true);
    });

    it("升级:旧版写入的保留字模型 ID(sonnet)被换成 legacy- 新 ID,两进程并发、重复启动都成功", async () => {
      const { db } = a;
      await db.delete(platformState).where(eq(platformState.k, BOOTSTRAP_KEY));
      await db.delete(modelAliases);
      await db
        .delete(capabilityCatalog)
        .where(eq(capabilityCatalog.providerId, "platform-default"));
      await db.delete(capabilityVersions).where(like(capabilityVersions.capabilityId, "default-%"));
      await db.delete(capabilityVersions).where(like(capabilityVersions.capabilityId, "legacy-%"));
      await db.delete(capabilityVersions).where(eq(capabilityVersions.capabilityId, "sonnet"));
      await db.delete(capabilityCatalog).where(eq(capabilityCatalog.id, "sonnet"));
      await db.delete(modelProviders).where(eq(modelProviders.id, "platform-default"));
      // 旧版允许的写法,按新规则保存不了:直接写表
      const legacy = {
        id: "sonnet",
        name: "旧主力",
        kind: "llm",
        modelId: OFFICIAL_MODEL_IDS.sonnet,
        enabled: true,
        acceptsImages: false,
        rates: [{ meter: "input_token", units: "1000", microCredits: "3333" }],
      };
      const at = new Date();
      await db.insert(capabilityCatalog).values({
        id: "sonnet",
        kind: "llm",
        modelId: legacy.modelId,
        enabled: 1,
        version: 1,
        definition: legacy,
        updatedAt: at,
      });
      await db.insert(capabilityVersions).values({
        capabilityId: "sonnet",
        version: 1,
        definition: legacy,
        createdBy: "legacy",
        createdAt: at,
      });

      await Promise.all([bootstrapProviders(depsOf(a)), bootstrapProviders(depsOf(b))]);
      await bootstrapProviders(depsOf(a));

      const repo = new MysqlCapabilityRepo(db);
      const replaced = await repo.get("legacy-sonnet");
      expect(replaced).toMatchObject({ providerId: "platform-default", enabled: true, version: 1 });
      expect(replaced?.rates).toEqual(legacy.rates);
      expect(await repo.get("sonnet")).toMatchObject({
        enabled: false,
        replacedBy: "legacy-sonnet",
        version: 2,
      });
      expect((await repo.version("sonnet", 1))?.rates).toEqual(legacy.rates);
      expect((await new MysqlModelAliasRepo(db).get())?.sonnet).toBe("legacy-sonnet");
      expect(await new MysqlBootstrapMarker(db).isDone(BOOTSTRAP_KEY)).toBe(true);
    });
  });
}
