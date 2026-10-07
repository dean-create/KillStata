/**
 * 将数值格式化为指定位数的小数字符串；null/undefined 返回替代文本。
 * @param v     待格式化的值
 * @param d     小数位数（默认 4）
 * @param na    替代文本（默认 "未提供"）
 */
export function numberText(v: number | null | undefined, d = 4, na = "未提供"): string {
  return typeof v === "number" ? v.toFixed(d) : na
}
