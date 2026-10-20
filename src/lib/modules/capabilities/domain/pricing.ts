// 成本价(元)→ 积分价的换算。纯函数,前后端共用;全程整数,不经过浮点。
import type { CapabilityKind, CreditRate, Meter } from "./catalog";

/** 1 元 = 100 积分 = 100,000,000 微积分,所以元最多 8 位小数即可无损换算。 */
const MICRO_PER_YUAN = 100_000_000n;
const BP = 10_000n;
const INTEGER = /^(0|[1-9]\d{0,29})$/;

function intOf(raw: string, field: string): bigint {
  if (!INTEGER.test(raw)) throw new Error(`${field} 须为非负整数字符串`);
  return BigInt(raw);
}

/** 加价上限 1000%,防止误填多个 0。 */
export const MAX_MARKUP_BP = 100_000;

/** 充值套餐的最大赠送比例(专业包 8%)。加价不高于它时提醒可能没有成本余量。 */
export const MAX_RECHARGE_BONUS_BP = 800;

/** 每种类型在界面上录入的计量项与计价单位。item 为空表示该类型只有一个计量项。 */
export const STANDARD_METERS: Record<
  CapabilityKind,
  readonly { meter: Meter; units: string; label: string; item: string; unit: string }[]
> = {
  llm: [
    {
      meter: "input_token",
      units: "1000000",
      label: "输入 / 百万 token",
      item: "输入",
      unit: "百万 token",
    },
    {
      meter: "output_token",
      units: "1000000",
      label: "输出 / 百万 token",
      item: "输出",
      unit: "百万 token",
    },
    {
      meter: "cache_read_token",
      units: "1000000",
      label: "缓存读取 / 百万 token",
      item: "缓存读取",
      unit: "百万 token",
    },
    {
      meter: "cache_write_token",
      units: "1000000",
      label: "缓存写入 / 百万 token",
      item: "缓存写入",
      unit: "百万 token",
    },
  ],
  image: [{ meter: "image", units: "1", label: "每张", item: "", unit: "张" }],
  video: [{ meter: "video_ms", units: "1000", label: "每秒", item: "", unit: "秒" }],
  speech: [{ meter: "character", units: "10000", label: "每万字符", item: "", unit: "万字符" }],
  transcription: [
    { meter: "audio_input_ms", units: "60000", label: "每分钟", item: "", unit: "分钟" },
  ],
};

/** "21.5" 元 → 微积分整数字符串。最多 8 位小数,非负。 */
export function parseYuan(text: string): string {
  if (!/^(0|[1-9]\d{0,19})(\.\d{1,8})?$/.test(text)) {
    throw new Error("金额须为非负数,最多 8 位小数");
  }
  const [whole = "0", fraction = ""] = text.split(".");
  return (BigInt(whole) * MICRO_PER_YUAN + BigInt(fraction.padEnd(8, "0"))).toString();
}

/** 微积分 → 元的十进制字符串(去掉末尾 0)。 */
export function formatYuan(microCredits: string): string {
  const v = intOf(microCredits, "microCredits");
  const fraction = (v % MICRO_PER_YUAN).toString().padStart(8, "0").replace(/0+$/, "");
  return `${v / MICRO_PER_YUAN}${fraction ? `.${fraction}` : ""}`;
}

/** "10" / "12.5" (%) → 万分比整数。最多 2 位小数。 */
export function parseMarkupPercent(text: string): number {
  if (!/^(0|[1-9]\d{0,3})(\.\d{1,2})?$/.test(text)) {
    throw new Error("加价比例须为非负数,最多 2 位小数");
  }
  const [whole = "0", fraction = ""] = text.split(".");
  const bp = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (bp > MAX_MARKUP_BP) throw new Error("加价比例不能超过 1000%");
  return bp;
}

export function formatMarkupPercent(bp: number): string {
  const whole = Math.floor(bp / 100);
  const fraction = String(bp % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function markupBpOf(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_MARKUP_BP) {
    throw new Error(`加价比例须为 0~${MAX_MARKUP_BP} 的整数万分比`);
  }
  return raw;
}

/** 售价 = 成本 × (1 + 加价),按计量项向上取整到 1 微积分。 */
export function deriveSaleRates(costRates: readonly CreditRate[], markupBp: number): CreditRate[] {
  const factor = BP + BigInt(markupBpOf(markupBp));
  return costRates.map((r) => {
    const cost = intOf(r.microCredits, "microCredits");
    return { ...r, microCredits: ((cost * factor + BP - 1n) / BP).toString() };
  });
}

/** 加价不高于最大充值赠送比例:用充值赠送的积分使用该模型时可能没有成本余量或低于成本。 */
export function markupMarginWarning(markupBp: number): boolean {
  return markupBp <= MAX_RECHARGE_BONUS_BP;
}
