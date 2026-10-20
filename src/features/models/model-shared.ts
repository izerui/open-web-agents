// 模型管理界面共用:类型标签、接口形状、成本价 ↔ 积分价换算(复用服务端同一套纯函数)。
import type {
  Capability,
  CapabilityKind,
  CreditRate,
  Meter,
} from "@/lib/modules/capabilities/domain/catalog";
import { formatCredits } from "@/lib/modules/capabilities/domain/catalog";
import { STANDARD_METERS, formatYuan } from "@/lib/modules/capabilities/domain/pricing";

export const KIND_LABEL: Record<CapabilityKind, string> = {
  llm: "文本",
  image: "生图",
  video: "生视频",
  speech: "语音合成",
  transcription: "语音转写",
};

export const KIND_ORDER: CapabilityKind[] = ["llm", "image", "video", "speech", "transcription"];

export interface ProviderEndpoint {
  protocol: string;
  baseUrl: string;
}

export interface ProviderView {
  id: string;
  name: string;
  enabled: boolean;
  endpoints: Partial<Record<CapabilityKind, ProviderEndpoint>>;
  hasKey: boolean;
  keyHint: string | null;
  version: number;
  modelCounts?: Record<CapabilityKind, number>;
}

export interface AliasMapView {
  providerId: string;
  fable: string;
  opus: string;
  sonnet: string;
  haiku: string;
  version: number;
}

export type AdminModel = Capability & { providerName: string | null };

export interface Impact {
  agents: number;
  aliases: string[];
}

/**
 * 某计量项按标准单位(如每百万 token)折算后的微积分。旧数据的单位可能不同;
 * 除不尽时向上取整,exact=false 提示管理员重新保存以标准化。
 */
export function perStandard(
  rates: readonly CreditRate[] | undefined,
  meter: Meter,
  stdUnits: string,
): { micro: string; exact: boolean } | null {
  const r = rates?.find((x) => x.meter === meter);
  if (!r) return null;
  const scaled = BigInt(r.microCredits) * BigInt(stdUnits);
  const units = BigInt(r.units);
  return {
    micro: ((scaled + units - 1n) / units).toString(),
    exact: scaled % units === 0n,
  };
}

/** 积分价显示:最多 6 位小数,去尾零;大数加千分位。 */
export function creditsText(micro: string): string {
  const [whole = "0", fraction] = formatCredits(micro).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function yuanText(micro: string): string {
  return formatYuan(micro);
}

/** 模型在表格里展示的价格行:每个标准计量项的成本(元)与售价(积分) */
export function priceRows(m: Pick<Capability, "kind" | "rates" | "costRates">) {
  return STANDARD_METERS[m.kind].map((s) => {
    const cost = perStandard(m.costRates, s.meter, s.units);
    const sale = perStandard(m.rates, s.meter, s.units);
    return {
      meter: s.meter,
      label: s.label,
      costYuan: cost ? yuanText(cost.micro) : null,
      saleCredits: sale ? creditsText(sale.micro) : null,
      exact: (cost?.exact ?? true) && (sale?.exact ?? true),
    };
  });
}
