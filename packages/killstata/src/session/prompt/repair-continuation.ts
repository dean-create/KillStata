import { AUTOMATIC_TOOL_REPAIR_LIMIT } from "./types"

export function shouldReplanAfterRepairText(input: {
  repairPending: boolean
  attempts: number
  text: string
  latestUserText?: string
}) {
  if (!input.repairPending || input.attempts >= AUTOMATIC_TOOL_REPAIR_LIMIT) return false
  const text = input.text.trim()
  if (!text) return false

  // 用户明确要求只报告、停止或不要继续操作时，repair 不能越过这个边界。
  if (/(?:只(?:告诉|说明|判断)|不要|请勿|不必|无需)[^。\n]{0,30}(?:继续|重试|导入|分析|调用|操作|执行)/i.test(input.latestUserText ?? "")) {
    return false
  }

  // 模型明确把控制权交还用户时，不能为了“继续尝试”越过研究设计或数据处理决策。
  // 普通的中间说明则需要再给一次工具搜索/替代工具的机会，避免 repair 合成消息
  // 被模型的一段文字收尾吞掉。
  return !/(?:请你|请用户|需要你|需要用户|请确认|是否|请提供|请选择|请告诉|无法继续|不能继续|停止分析|交给用户)/i.test(text)
}
