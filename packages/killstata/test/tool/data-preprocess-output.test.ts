import { describe, expect, test } from "bun:test"
import { formatDataPreprocessOutput } from "@/tool/data-preprocess"

describe("data_preprocess model output", () => {
  test("a mutation exposes the exact canonical stage for the next tool call", () => {
    const output = formatDataPreprocessOutput({
      datasetId: "dataset_1",
      effectiveStageId: "stage_001",
      parentStageId: "stage_000",
      method: "combine_columns",
      columns: ["省份", "地区"],
      mutation: true,
      result: {
        rowsBefore: 100,
        rowsAfter: 100,
        columnsBefore: 8,
        columnsAfter: 9,
        warnings: [],
        createdColumns: ["复合实体"],
      },
    })

    expect(output).toContain("datasetId=dataset_1")
    expect(output).toContain("stageId=stage_001")
    expect(output).toContain("后续 describe、数据质量检查 和估计")
    expect(output).toContain("不要使用 workflow 的内部节点 ID")
    expect(output).toContain("保留全部原始观测")
    expect(output).toContain("未删除行")
  })
})
