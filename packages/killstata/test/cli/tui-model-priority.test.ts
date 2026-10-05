import { describe, expect, test } from "bun:test"
import { selectTuiModel, type TuiModelRef } from "@/cli/cmd/tui/context/model-priority"

const valid = (model: TuiModelRef) => model.providerID === "custom" || model.providerID === "deepseek"

describe("TUI模型选择优先级", () => {
  test("显式命令行模型优先于异步加载的本地旧模型", () => {
    const explicit = { providerID: "custom", modelID: "agnes-2.5-flash" }
    const stored = { providerID: "deepseek", modelID: "deepseek-v4-flash" }

    expect(selectTuiModel({ explicit, stored }, valid)).toEqual(explicit)
  })

  test("没有显式模型时保留本地选择，再回落到agent/default", () => {
    const stored = { providerID: "deepseek", modelID: "deepseek-v4-flash" }
    const agent = { providerID: "custom", modelID: "agnes-2.5-flash" }

    expect(selectTuiModel({ stored, agent }, valid)).toEqual(stored)
  })
})
