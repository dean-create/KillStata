import { describe, expect, it } from "vitest"
import { toolProgressLabel, toolProgressMessage } from "./tool-progress"

describe("Desktop tool progress projection", () => {
  it("uses the live data_import action names from the harness contract", () => {
    expect(toolProgressLabel("data_import", { analysisView: { step: "data_import(profile)" } }))
      .toBe("读取数据概览")
    expect(toolProgressLabel("data_import", { analysisView: { step: "data_import(validate)" } }))
      .toBe("检查数据质量")
  })

  it("uses the failed data_import action and gives a recoverable profile explanation", () => {
    const input = { action: "profile" }
    const label = toolProgressLabel("data_import", undefined, input)

    expect(label).toBe("读取数据概览")
    expect(toolProgressMessage(
      label,
      "error",
      "工具执行失败：数据动作 profile 需要 inputPath，或提供当前会话的 datasetId。",
      { tool: "data_import", input },
    )).toBe("读取数据概览未成功：缺少当前数据集引用。正在使用最新数据阶段修复。")
  })
})
