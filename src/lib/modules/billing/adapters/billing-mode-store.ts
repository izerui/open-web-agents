import type { Db } from "@/lib/db/client";
import { platformState } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { BILLING_MODES, type BillingMode } from "../domain/run-charge";
import type { BillingModeStore } from "../run-charge-ports";

const KEY = "billing_mode";

/** 全局计费模式存在 platform_state;没有记录 = 试算(阶段 0 不扣费是默认) */
export class MysqlBillingModeStore implements BillingModeStore {
  constructor(private readonly db: Db) {}

  async get(): Promise<BillingMode> {
    const [row] = await this.db
      .select({ v: platformState.v })
      .from(platformState)
      .where(eq(platformState.k, KEY))
      .limit(1);
    return row && (BILLING_MODES as readonly string[]).includes(row.v)
      ? (row.v as BillingMode)
      : "trial";
  }

  async set(mode: BillingMode): Promise<void> {
    await this.db
      .insert(platformState)
      .values({ k: KEY, v: mode })
      .onDuplicateKeyUpdate({ set: { v: mode } });
  }
}

export class InMemoryBillingModeStore implements BillingModeStore {
  constructor(private mode: BillingMode = "trial") {}
  async get() {
    return this.mode;
  }
  async set(mode: BillingMode) {
    this.mode = mode;
  }
}
