// 首次启动时建好已确认的充值套餐档位。系统里已有任何套餐(含停用的)就不动 —— 管理员配过的以管理员为准。
import { parseCredits } from "@/lib/modules/capabilities/domain/catalog";
import type { PackageDefinition, PackageRepo } from "../package-ports";

/** 确认过的档位:¥10/1000,¥30/3090(赠 3%),¥100/10500(赠 5%),¥300/32400(赠 8%);积分不过期 */
export const DEFAULT_PACKAGES: PackageDefinition[] = [
  { yuan: 10, credits: "1000", bonus: "" },
  { yuan: 30, credits: "3090", bonus: "(赠 3%)" },
  { yuan: 100, credits: "10500", bonus: "(赠 5%)" },
  { yuan: 300, credits: "32400", bonus: "(赠 8%)" },
].map((p) => ({
  id: `pkg-${p.yuan}`,
  name: `${p.credits} 积分${p.bonus}`,
  description: `¥${p.yuan},积分不过期`,
  creditsMicro: parseCredits(p.credits),
  priceMinor: String(p.yuan * 100),
  currency: "CNY" as const,
  enabled: true,
}));

export async function seedDefaultPackages(
  repo: Pick<PackageRepo, "list" | "save">,
  warn: (message: string) => void = (m) => console.warn(`[packages] ${m}`),
): Promise<number> {
  if ((await repo.list(true)).length > 0) return 0;
  let created = 0;
  for (const def of DEFAULT_PACKAGES) {
    try {
      await repo.save(def, null, "system");
      created++;
    } catch (err) {
      // 多个进程同时启动:别人先建了同一个 id,忽略
      warn(`默认套餐 ${def.id} 未创建:${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return created;
}
