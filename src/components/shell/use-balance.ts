"use client";

import { fetchJson } from "@/lib/fetch-json";
import { creditsAmount, creditsBalance } from "@/lib/modules/billing/domain/credits-display";
import { useEffect, useState } from "react";

export type Balance =
  | { status: "loading" }
  /** 读不到积分账户:本地模式的匿名管理员没有账号(接口回「账号不存在」),或接口出错 */
  | { status: "none" }
  | {
      status: "ok";
      /** 可用积分(两位小数向下取整) */
      available: string;
      /** 冻结中 */
      reserved: string;
      /** 本月已用 */
      monthUsed: string;
      /** 月度上限;null = 未设置 */
      monthLimit: string | null;
    };

interface BillingBody {
  balance: { availableMicroCredits: string; reservedMicroCredits?: string };
  month?: { usedMicroCredits?: string; limitMicroCredits?: string | null };
}

/**
 * 当前账号的积分概况:顶栏积分胶囊、头像菜单「积分与套餐」右边的余额、手机「我的」页的大卡。
 * 每次换页(外壳重新挂载)读一次就够 —— 精确数字在积分页。
 */
export function useBalance(enabled: boolean): Balance {
  const [state, setState] = useState<Balance>({ status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetchJson<BillingBody>("/api/billing?limit=1")
      .then((r) => {
        if (!alive) return;
        setState({
          status: "ok",
          available: creditsBalance(r.balance.availableMicroCredits),
          reserved: creditsAmount(r.balance.reservedMicroCredits ?? "0"),
          monthUsed: creditsAmount(r.month?.usedMicroCredits ?? "0"),
          monthLimit: r.month?.limitMicroCredits ? creditsAmount(r.month.limitMicroCredits) : null,
        });
      })
      .catch(() => alive && setState({ status: "none" }));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return state;
}
