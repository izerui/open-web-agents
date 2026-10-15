/** 当前套餐支持两位小数的 CNY / USD,金额始终按整数字符串换算。 */
export function parsePrice(value: string): string {
  if (!/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/.test(value) || value.trim() !== value) {
    throw new Error("价格须为非负数,最多两位小数");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))).toString();
}

export function formatPrice(value: string, currency: "CNY" | "USD"): string {
  if (!/^(0|[1-9]\d{0,17})$/.test(value) || value.trim() !== value) throw new Error("价格格式错误");
  const amount = BigInt(value);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")} ${currency}`;
}
