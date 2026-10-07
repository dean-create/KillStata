/** 解析 CLI 传入的多轮 Question 选项下标；非法输入必须显式失败，不能猜测。 */
export function parseQuestionOptionIndexes(raw: string | undefined): number[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined
  const values = raw.split(",").map((item) => item.trim())
  if (values.some((item) => !/^\d+$/.test(item))) {
    throw new Error("--question-indexes 只能包含逗号分隔的非负整数，例如 1,0")
  }
  return values.map(Number)
}
