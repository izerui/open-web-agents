import { InMemoryCapabilityRepo } from "@/lib/modules/capabilities/adapters/in-memory-capability-repo";
import { describe, expect, it } from "vitest";
import {
  InMemoryModelAliasRepo,
  InMemoryProviderRepo,
} from "../../adapters/in-memory-provider-repo";
import { ModelUnavailable } from "../../domain/resolve-run-models";
import { ModelResolver } from "../model-resolver";
import { platformModels } from "./platform-models";

describe("ModelResolver", () => {
  it("解出本次运行的 Base URL 与解密后的 Key", async () => {
    const resolve = platformModels({ baseUrl: "https://gw.example/", key: "sk-real" });
    const r = await resolve({ main: "sonnet" });
    expect(r.credentials).toEqual({ baseUrl: "https://gw.example", key: "sk-real" });
    expect(r.binding.main.modelId).toBe("model-sonnet");
  });

  it("Key 解不开时报错,不静默当成空 Key", async () => {
    const resolve = platformModels({ baseUrl: "https://gw.example", key: "sk-real" });
    await resolve.ready;
    await resolve.providers.setKey("platform-default", "broken-cipher", "****", "t");
    await expect(resolve({ main: "sonnet" })).rejects.toThrow(/无法解密/);
  });

  it("先等初始化完成;初始化失败时向上抛出", async () => {
    const resolver = new ModelResolver({
      ensureModels: async () => {
        throw new Error("数据库不可用");
      },
      capabilities: new InMemoryCapabilityRepo(),
      providers: new InMemoryProviderRepo(),
      aliases: new InMemoryModelAliasRepo(),
      decrypt: () => "k",
    });
    await expect(resolver.resolve({ main: "sonnet" })).rejects.toThrow(/数据库不可用/);
  });

  it("没有任何配置:平台未配置", async () => {
    const resolver = new ModelResolver({
      ensureModels: async () => {},
      capabilities: new InMemoryCapabilityRepo(),
      providers: new InMemoryProviderRepo(),
      aliases: new InMemoryModelAliasRepo(),
      decrypt: () => "k",
    });
    await expect(resolver.resolve({ main: "sonnet" })).rejects.toBeInstanceOf(ModelUnavailable);
  });

  it("受理时就不可用的运行:即使模型现在可用,执行时也照此失败,不重新解析", async () => {
    const resolve = platformModels({ baseUrl: "https://gw.example", key: "sk-real" });
    // 模型此刻完全可用
    expect((await resolve({ main: "sonnet" })).binding.main.modelId).toBe("model-sonnet");
    const err = await resolve({
      main: "sonnet",
      pinned: { unavailableAtAdmission: { code: "model_disabled", message: "模型已停用" } },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelUnavailable);
    expect(err).toMatchObject({ code: "model_disabled", message: "模型已停用" });
  });

  it("没有快照的旧任务(pinned 为空)仍按配置现解析", async () => {
    const resolve = platformModels({ baseUrl: "https://gw.example", key: "sk-real" });
    expect((await resolve({ main: "sonnet", pinned: null })).binding.main.modelId).toBe(
      "model-sonnet",
    );
  });
});
