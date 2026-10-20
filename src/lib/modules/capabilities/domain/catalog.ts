/** 能力目录与积分价目。积分使用百万分之一单位,JSON/数据库使用十进制整数字符串。 */
import { deriveSaleRates, markupBpOf } from "./pricing";
export const CAPABILITY_KINDS = ["llm", "image", "video", "speech", "transcription"] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export const METERS = [
  "input_token",
  "output_token",
  "cache_read_token",
  "cache_write_token",
  "image",
  "video_ms",
  "audio_input_ms",
  "audio_output_ms",
  "character",
] as const;
export type Meter = (typeof METERS)[number];

export const KIND_METERS: Record<CapabilityKind, readonly Meter[]> = {
  llm: ["input_token", "output_token", "cache_read_token", "cache_write_token"],
  image: ["image", "input_token", "output_token"],
  video: ["video_ms"],
  speech: ["character", "audio_output_ms", "input_token", "output_token"],
  transcription: ["audio_input_ms", "input_token", "output_token"],
};

export interface CreditRate {
  meter: Meter;
  /** 每 units 个计量单位的价格,以微积分计。0 表示管理员明确设置的免费价。 */
  units: string;
  microCredits: string;
}

export interface CapabilityDefinition {
  id: string;
  name: string;
  kind: CapabilityKind;
  /** 管理员配置的实际模型标识,不接受用户请求随意替换。 */
  modelId: string;
  enabled: boolean;
  /** LLM 的图片理解仍属于 llm,不混进生图类别。 */
  acceptsImages: boolean;
  /** 售价:用户实际被扣的积分价。有 costRates 时由成本与加价派生,不接受直接传入。 */
  rates: CreditRate[];
  /** 所属提供者。旧数据在迁移收编前为空。 */
  providerId?: string;
  /** 加价比例(万分比)。与 costRates 同时出现。 */
  markupBp?: number;
  /** 成本积分价(成本单价 × 100),计量项与单位同 rates。 */
  costRates?: CreditRate[];
  /** 旧记录已被这条新模型替代(只由迁移写入,停用后保留价目历史) */
  replacedBy?: string;
  /** 文本模型单次运行的冻结额(微积分);不配用平台默认 */
  reserveMicroCredits?: string;
}

/** 智能体配置里的模型别名,作为保留字不得用作模型 ID。 */
export const RESERVED_IDS = new Set(["fable", "opus", "sonnet", "haiku"]);
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface Capability extends CapabilityDefinition {
  version: number;
  updatedAt: number;
}

export const MICRO_CREDITS = 1_000_000n;
const INTEGER = /^(0|[1-9]\d{0,29})$/;

export function unitsOf(raw: unknown, field: string): bigint {
  if (typeof raw !== "string" || raw.trim() !== raw || !INTEGER.test(raw)) {
    throw new Error(`${field} 须为最多 30 位的非负整数字符串`);
  }
  return BigInt(raw);
}

export function validateCapability(raw: unknown): CapabilityDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("能力定义必须是对象");
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.trim() !== v.id || !SLUG.test(v.id)) {
    throw new Error("ID 须为最多 64 个小写字母、数字、下划线或连字符");
  }
  if (RESERVED_IDS.has(v.id)) throw new Error("ID 不能使用模型别名 fable/opus/sonnet/haiku");
  if (
    v.providerId !== undefined &&
    (typeof v.providerId !== "string" || !SLUG.test(v.providerId))
  ) {
    throw new Error("提供者 ID 格式不正确");
  }
  if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 120)
    throw new Error("名称须为 1~120 个字符");
  if (!CAPABILITY_KINDS.includes(v.kind as CapabilityKind)) throw new Error("未知能力类型");
  if (typeof v.modelId !== "string" || !v.modelId.trim() || v.modelId.length > 200)
    throw new Error("须填写实际模型标识");
  if (typeof v.enabled !== "boolean" || typeof v.acceptsImages !== "boolean")
    throw new Error("启用与图片理解标志必须是布尔值");
  if (v.acceptsImages && v.kind !== "llm") throw new Error("图片理解标志只适用于 LLM");
  const kind = v.kind as CapabilityKind;
  let rates: CreditRate[];
  let pricing: Pick<CapabilityDefinition, "markupBp" | "costRates"> = {};
  if (v.costRates !== undefined) {
    const costRates = validateRates(v.costRates, kind, "成本价");
    const markupBp = markupBpOf(v.markupBp);
    rates = deriveSaleRates(costRates, markupBp);
    pricing = { markupBp, costRates };
  } else {
    if (v.markupBp !== undefined) throw new Error("加价比例须与成本价一起提供");
    rates = validateRates(v.rates, kind, "价目");
  }
  if (v.enabled && rates.length === 0) throw new Error("启用能力前须明确配置价目");
  return {
    id: v.id,
    name: v.name.trim(),
    kind,
    modelId: v.modelId.trim(),
    enabled: v.enabled,
    acceptsImages: v.acceptsImages,
    rates,
    ...(typeof v.providerId === "string" ? { providerId: v.providerId } : {}),
    ...(v.reserveMicroCredits !== undefined && v.reserveMicroCredits !== null
      ? { reserveMicroCredits: reserveOf(v.reserveMicroCredits, kind) }
      : {}),
    ...pricing,
  };
}

function reserveOf(raw: unknown, kind: CapabilityKind): string {
  if (kind !== "llm") throw new Error("单次运行冻结额只适用于文本模型");
  if (unitsOf(raw, "reserveMicroCredits") === 0n) throw new Error("单次运行冻结额必须大于零");
  return raw as string;
}

function validateRates(raw: unknown, kind: CapabilityKind, label: string): CreditRate[] {
  if (!Array.isArray(raw) || raw.length > METERS.length) throw new Error(`${label}须为计量项列表`);
  const meters = new Set<string>();
  return raw.map((rawRate: unknown) => {
    if (!rawRate || typeof rawRate !== "object" || Array.isArray(rawRate))
      throw new Error("计量项格式不正确");
    const rate = rawRate as Record<string, unknown>;
    if (!KIND_METERS[kind].includes(rate.meter as Meter))
      throw new Error("计量单位与能力类型不匹配");
    if (meters.has(rate.meter as string)) throw new Error("计量项不能重复");
    meters.add(rate.meter as string);
    if (unitsOf(rate.units, "units") === 0n) throw new Error("计量基数必须大于零");
    unitsOf(rate.microCredits, "microCredits");
    return {
      meter: rate.meter as Meter,
      units: rate.units as string,
      microCredits: rate.microCredits as string,
    };
  });
}

export type MeteredUsage = Partial<Record<Meter, string>>;

/** 每个计量项按微积分向上取整后求和;未知单位或缺少价格绝不当作免费。 */
export function priceUsage(
  rates: CreditRate[],
  usage: MeteredUsage,
): {
  microCredits: string;
  lines: { meter: Meter; quantity: string; microCredits: string }[];
} {
  const price = new Map(rates.map((rate) => [rate.meter, rate]));
  if (price.size !== rates.length) throw new Error("价目有重复计量项");
  const lines: { meter: Meter; quantity: string; microCredits: string }[] = [];
  let total = 0n;
  for (const [meter, raw] of Object.entries(usage)) {
    if (!METERS.includes(meter as Meter)) throw new Error(`未知计量单位:${meter}`);
    const quantity = unitsOf(raw, meter);
    if (quantity === 0n) continue;
    const rate = price.get(meter as Meter);
    if (!rate) throw new Error(`缺少 ${meter} 的积分价格`);
    const size = unitsOf(rate.units, "units");
    if (size === 0n) throw new Error("计量基数必须大于零");
    const amount = (quantity * unitsOf(rate.microCredits, "microCredits") + size - 1n) / size;
    total += amount;
    if (total.toString().length > 30) throw new Error("积分金额超出存储范围");
    lines.push({
      meter: meter as Meter,
      quantity: quantity.toString(),
      microCredits: amount.toString(),
    });
  }
  return { microCredits: total.toString(), lines };
}

/** UI 十进制积分输入,禁止浮点乘法参与账务。 */
export function parseCredits(text: string): string {
  if (!/^(0|[1-9]\d{0,23})(\.\d{1,6})?$/.test(text)) throw new Error("积分须为非负数,最多六位小数");
  const [whole = "0", fraction = ""] = text.split(".");
  return (BigInt(whole) * MICRO_CREDITS + BigInt(fraction.padEnd(6, "0"))).toString();
}

export function formatCredits(microCredits: string): string {
  const value = unitsOf(microCredits, "microCredits");
  const fraction = (value % MICRO_CREDITS).toString().padStart(6, "0").replace(/0+$/, "");
  return `${value / MICRO_CREDITS}${fraction ? `.${fraction}` : ""}`;
}
