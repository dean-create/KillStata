import { expect, test } from "bun:test"
import { sanitizeRunFinalText, shouldPrintRunTextPart, userFacingToolLabel } from "@/cli/cmd/run"

test("CLI最终文本统一净化内部ID、临时路径和工具名", () => {
  const output = sanitizeRunFinalText(
    "已完成 data_import。datasetId=gf_ab47a6ce，stageId=stage_000。文件：/var/folders/l9/example/did.xlsx。",
    "导入 did.xlsx 并分析",
  )

  expect(output).not.toContain("data_import")
  expect(output).not.toContain("datasetId")
  expect(output).not.toContain("stageId")
  expect(output).not.toContain("/var/folders/")
})

test("CLI进度标签使用用户语言，不展示内部工具ID", () => {
  expect(userFacingToolLabel("data_import", { action: "profile" })).toBe("数据画像")
  expect(userFacingToolLabel("econometrics_recommend")).toBe("计量方法推荐")
  expect(userFacingToolLabel("ols_regression")).toBe("OLS回归")
})

test("CLI流式正文隐藏合成续接提示和内部压缩摘要，但保留用户回答", () => {
  const summaries = new Set(["message_summary"])
  expect(shouldPrintRunTextPart({ type: "text", messageID: "message_summary" }, summaries)).toBe(false)
  expect(shouldPrintRunTextPart({ type: "text", messageID: "message_continuation", synthetic: true }, summaries)).toBe(false)
  expect(shouldPrintRunTextPart({ type: "text", messageID: "message_answer", synthetic: false, ignored: false }, summaries)).toBe(true)
})
