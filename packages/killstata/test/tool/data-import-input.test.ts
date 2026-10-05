import { describe, expect, test } from "bun:test"
import { requireResolvableInput } from "@/tool/data-import/import-runner"

describe("数据动作引用补全", () => {
  test("已有唯一 datasetId 时允许省略 stageId，由工具使用当前最新阶段", () => {
    expect(() => requireResolvableInput("frequency", { datasetId: "dataset_current" })).not.toThrow()
  })
})
