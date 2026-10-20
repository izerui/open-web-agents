// 积分在界面上的显示规则(内部全程微积分,1 积分 = 1,000,000 微积分):
// - 消耗、价格等金额:≥ 0.01 保留两位小数(四舍五入),不足 0.01 显示 "< 0.01",0 显示 "0"
// - 余额:两位小数向下取整 —— 绝不显示比实际多的余额
// - 明细:完整六位小数

const MICRO = 1_000_000n;
const CENT = 10_000n; // 0.01 积分

function grouped(whole: bigint): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function twoDecimals(cents: bigint): string {
  return `${grouped(cents / 100n)}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function parse(micro: string | bigint): bigint {
  const v = typeof micro === "bigint" ? micro : BigInt(micro);
  if (v < 0n) throw new Error("积分不能为负");
  return v;
}

/** 消耗、冻结等金额 */
export function creditsAmount(micro: string | bigint): string {
  const v = parse(micro);
  if (v === 0n) return "0";
  if (v < CENT) return "< 0.01";
  return twoDecimals((v + CENT / 2n) / CENT);
}

/** 余额:向下取整到 0.01 */
export function creditsBalance(micro: string | bigint): string {
  return twoDecimals(parse(micro) / CENT);
}

/** 明细:完整六位小数 */
export function creditsExact(micro: string | bigint): string {
  const v = parse(micro);
  return `${grouped(v / MICRO)}.${(v % MICRO).toString().padStart(6, "0")}`;
}
