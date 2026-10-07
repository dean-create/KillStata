import { describe, expect, test } from "bun:test"
import { shouldReplanAfterRepairText } from "@/session/prompt/repair-continuation"

describe("repair 后的模型重新规划", () => {
  test("repair 中模型只返回普通文字时，在预算内再次给工具选择机会", () => {
    expect(
      shouldReplanAfterRepairText({
        repairPending: true,
        attempts: 1,
        text: "我先整理一下当前结果。",
      }),
    ).toBe(true)
  })

  test("模型明确需要用户决定时不强行继续调用工具", () => {
    expect(
      shouldReplanAfterRepairText({
        repairPending: true,
        attempts: 1,
        text: "当前缺少相对时期，请你确认是否提供该变量。",
      }),
    ).toBe(false)
  })

  test("达到自动修复预算后必须停下并保留用户决策入口", () => {
    expect(
      shouldReplanAfterRepairText({
        repairPending: true,
        attempts: 3,
        text: "我再试试其他方式。",
      }),
    ).toBe(false)
  })

  test("用户明确要求只报告错误时不强行继续调用工具", () => {
    expect(
      shouldReplanAfterRepairText({
        repairPending: true,
        attempts: 1,
        text: "文件不存在，读取失败。",
        latestUserText: "只告诉我文件是否存在，不要继续导入或执行其他操作。",
      }),
    ).toBe(false)
  })
})
