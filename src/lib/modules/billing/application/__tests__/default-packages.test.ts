import { describe, expect, it } from "vitest";
import { InMemoryPackageRepo } from "../../adapters/in-memory-package-repo";
import { DEFAULT_PACKAGES, seedDefaultPackages } from "../default-packages";

describe("默认充值套餐", () => {
  it("没有任何套餐时按确认的档位建好;重复执行不再建", async () => {
    const repo = new InMemoryPackageRepo();
    expect(await seedDefaultPackages(repo)).toBe(4);
    const list = await repo.list(true);
    expect(list.map((p) => [p.priceMinor, p.creditsMicro, p.currency, p.enabled])).toEqual(
      expect.arrayContaining([
        ["1000", "1000000000", "CNY", true],
        ["3000", "3090000000", "CNY", true],
        ["10000", "10500000000", "CNY", true],
        ["30000", "32400000000", "CNY", true],
      ]),
    );
    expect(await seedDefaultPackages(repo)).toBe(0);
    expect(await repo.list(true)).toHaveLength(4);
  });

  it("已有管理员配置的套餐(哪怕停用):不动", async () => {
    const repo = new InMemoryPackageRepo();
    await repo.save({ ...DEFAULT_PACKAGES[0], id: "mine", enabled: false } as never, null, "admin");
    expect(await seedDefaultPackages(repo)).toBe(0);
    expect((await repo.list(true)).map((p) => p.id)).toEqual(["mine"]);
  });
});
