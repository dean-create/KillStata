import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import path from "path"
import { ToolResultProjection } from "@/runtime/tool-result-projection"
import { Truncate } from "@/tool/truncation"

describe("工具结果模型投影", () => {
  test("批次预算同时服从 25k 硬上限和当前模型输入窗口比例", () => {
    expect(ToolResultProjection.batchBudget()).toBe(25_000)
    expect(ToolResultProjection.batchBudget(1_000_000)).toBe(25_000)
    expect(ToolResultProjection.batchBudget(1_000)).toBe(150)
  })

  test("小而有信息的结果原样进入模型上下文", async () => {
    const output = "OLS 已完成。\n样本量：240\n核心系数：0.42\nQA：pass"
    const projected = await ToolResultProjection.project({
      toolName: "ols_regression",
      title: "OLS 回归",
      output,
      metadata: {},
      inputBudgetTokens: 128_000,
    })
    expect(projected.content).toBe(output)
    expect(projected.info).toMatchObject({ mode: "inline", originalTokens: ToolResultProjection.estimateTokens(output) })
  })

  test("极短结果补充 title、阶段证据和下一步，不只返回成功", async () => {
    const projected = await ToolResultProjection.project({
      toolName: "data_preprocess",
      title: "数据预处理",
      output: "成功",
      metadata: { datasetId: "dataset_1", stageId: "stage_2", artifactRefs: ["artifact:a"] },
      inputBudgetTokens: 128_000,
    })
    expect(projected.content).toContain("数据预处理")
    expect(projected.content).toContain("dataset_1")
    expect(projected.content).toContain("stage_2")
    expect(projected.content).toContain("下一步")
    expect(projected.info.mode).toBe("enriched")
  })

  test("极短正文附带大量结构化证据后仍服从单项预算", async () => {
    const metadata = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
      `nested_${index}`,
      { datasetId: `数据集_${index}_${"证据".repeat(300)}` },
    ]))
    const projected = await ToolResultProjection.project({
      toolName: "data_preprocess", title: "数据预处理", output: "成功", metadata, inputBudgetTokens: 128_000,
    })
    expect(ToolResultProjection.estimateTokens(projected.content)).toBeLessThanOrEqual(2_000)
  })

  test("长日志完整外部化，模型只看到有界高信号摘要与分页引用", async () => {
    const output = Array.from({ length: 8_000 }, (_, index) =>
      index % 997 === 0 ? `2026-08-24 14:${index % 60} ERROR regression failed at row ${index}` : `debug line ${index}`,
    ).join("\n")
    const projected = await ToolResultProjection.project({
      toolName: "bash",
      title: "运行分析命令",
      output,
      metadata: {},
      inputBudgetTokens: 128_000,
    })

    expect(projected.info.mode).toBe("externalized")
    expect(projected.info.outputReference).toStartWith("tool-output:")
    expect(ToolResultProjection.estimateTokens(projected.content)).toBeLessThanOrEqual(1_500)
    expect(projected.content).toContain("ERROR regression failed")
    expect(projected.content).toContain(projected.info.outputReference!)
    expect(projected.content).toContain("offset/limit")
    const file = Truncate.resolveOutputReference(projected.info.outputReference!)
    expect(file).toBeDefined()
    expect(fs.readFileSync(file!, "utf8")).toBe(output)
  })

  test("Read 兼容模型把分页引用分隔符从冒号改写为斜杠", () => {
    const canonical = "tool-output:tool_1234"
    const rewritten = "tool-output/tool_1234"

    expect(Truncate.isOutputReference(canonical)).toBe(true)
    expect(Truncate.isOutputReference(rewritten)).toBe(true)
    expect(Truncate.resolveOutputReference(rewritten)).toBe(Truncate.resolveOutputReference(canonical))
  })

  test("Read 兼容模型在引用前附加工作区相对路径", () => {
    const rewritten = "../../../../tool-output:tool_1234"
    expect(Truncate.isOutputReference(rewritten)).toBe(true)
    expect(Truncate.resolveOutputReference(rewritten)).toBe(path.join(Truncate.DIR, "tool_1234"))
  })

  test("长 JSON 保留关键状态、规模和产物引用，不把完整对象塞进摘要", async () => {
    const output = JSON.stringify({
      sessionID: "session_1",
      activeStage: "baseline_estimate",
      qaGateStatus: "pass",
      rowsUsed: 1234,
      artifactRefs: ["artifact:result", "artifact:diagnostics"],
      huge: Array.from({ length: 5_000 }, (_, index) => ({ index, noise: `value-${index}` })),
    }, null, 2)
    const projected = await ToolResultProjection.project({
      toolName: "pipeline",
      title: "工作流状态",
      output,
      metadata: {},
      inputBudgetTokens: 128_000,
    })
    expect(projected.content).toContain("baseline_estimate")
    expect(projected.content).toContain("qaGateStatus")
    expect(projected.content).toContain("artifact:result")
    expect(projected.content).not.toContain("value-4999")
  })

  test("同批结果受硬预算约束，并保留每项状态或外部引用", async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      toolName: `tool_${index}`,
      content: `## tool_${index}\n${"detail ".repeat(400)}`,
      outputReference: `tool-output:tool_${String(index).padStart(4, "0")}`,
    }))
    const fitted = await ToolResultProjection.fitBatch(items, 2_000)
    expect(ToolResultProjection.estimateBatch(fitted)).toBeLessThanOrEqual(2_000)
    expect(fitted).toHaveLength(items.length)
    for (const [index, item] of fitted.entries()) {
      expect(item.content).toContain(`tool_${index}`)
    }
  })

  test("tool_search 超预算时只投影完整方法 Schema 块，不裁断参数契约", async () => {
    const methodBlock = (methodID: string) => [
      `- 方法：${methodID}`,
      "  适用：测试方法",
      `  参数 Schema：${JSON.stringify({
        type: "object",
        properties: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
          `field_${index}`,
          { type: "string", description: `字段 ${index} 的完整契约说明`.repeat(12) },
        ])),
        required: ["field_0"],
      })}`,
      '  返回 Schema：{"type":"object","required":["success","payload"]}',
    ].join("\n")
    const first = methodBlock("method_alpha")
    const second = methodBlock("method_beta")
    const invalid = [
      "- 方法：method_invalid",
      '  参数 Schema：[]',
      '  返回 Schema：{"type":"object"}',
    ].join("\n")
    const content = `工具搜索结果：\n${first}\n${second}\n${invalid}`
    const budget = 6_000
    expect(ToolResultProjection.estimateTokens(`tool_search: ${first}`)).toBeLessThan(budget)
    expect(ToolResultProjection.estimateTokens(`tool_search: ${first}\n${second}`)).toBeGreaterThan(budget)

    const fitted = await ToolResultProjection.fitBatch([{ toolName: "tool_search", content }], budget)
    const projected = fitted[0].content
    const retained = [first, second].filter((block) => projected.includes(block))

    expect(ToolResultProjection.estimateBatch(fitted)).toBeLessThanOrEqual(budget)
    expect(retained).toHaveLength(1)
    expect(projected).toContain("完整 Schema")
    expect(projected).not.toContain("- 方法：method_invalid")
    expect(projected).toContain("method_invalid")
    for (const [methodID, block] of [["method_alpha", first], ["method_beta", second]] as const) {
      if (projected.includes(`- 方法：${methodID}`)) expect(projected).toContain(block)
    }
    expect(projected).not.toContain("tool-output:")
  })

  test("大量条目和中文输出仍严格服从批次预算", async () => {
    expect(ToolResultProjection.estimateTokens("中文结果".repeat(1_000))).toBeGreaterThanOrEqual(4_000)
    const items = Array.from({ length: 100 }, (_, index) => ({
      toolName: `工具_${index}`,
      content: "结果正常，但这里有很多中文细节。".repeat(100),
    }))
    const fitted = await ToolResultProjection.fitBatch(items, 1_000)
    expect(ToolResultProjection.estimateBatch(fitted)).toBeLessThanOrEqual(1_000)
    expect(fitted).toHaveLength(100)
  })

  test("条目数超过批次预算时允许空正文保留协议配对，但绝不突破硬预算", async () => {
    const items = Array.from({ length: 1_001 }, (_, index) => ({ toolName: `tool_${index}`, content: "detail".repeat(100) }))
    const fitted = await ToolResultProjection.fitBatch(items, 1_000)
    expect(fitted).toHaveLength(items.length)
    expect(ToolResultProjection.estimateBatch(fitted)).toBeLessThanOrEqual(1_000)
  })

  test("每项预算放不下引用信封时禁止制造无用外部文件", async () => {
    const persist = spyOn(Truncate, "persist").mockResolvedValue("tool-output:tool_unused")
    try {
      const items = Array.from({ length: 1_000 }, (_, index) => ({
        toolName: `tool_${index}`, content: "detail".repeat(100), fullOutput: "full".repeat(1_000),
      }))
      const fitted = await ToolResultProjection.fitBatch(items, 1_000)
      expect(ToolResultProjection.estimateBatch(fitted)).toBeLessThanOrEqual(1_000)
      expect(persist).toHaveBeenCalledTimes(0)
    } finally {
      persist.mockRestore()
    }
  })

  test("旧截断器已提供完整引用时必须复用，不能把预览再次当作全文写盘", async () => {
    const reference = await Truncate.persist("真正完整的结果")
    const projected = await ToolResultProjection.project({
      toolName: "pipeline", title: "工作流", output: "较短预览", metadata: { outputPath: reference }, inputBudgetTokens: 128_000,
    })
    expect(projected.info.outputReference).toBe(reference)
    expect(projected.content).toContain(reference)
  })

  test("媒体附件按模型能力、单项大小、数量和批次总量收口", () => {
    const budget = ToolResultProjection.createMediaBudget()
    const small = { mime: "image/png", url: "data:image/png;base64,aGVsbG8=" }
    const first = ToolResultProjection.projectMediaAttachments(Array.from({ length: 6 }, () => small), {
      image: true, pdf: false,
    }, budget)
    expect(first.attachments).toHaveLength(4)
    expect(first.notices.join(" ")).toContain("数量上限")

    const oversized = ToolResultProjection.projectMediaAttachments([{
      mime: "application/pdf",
      url: `data:application/pdf;base64,${"A".repeat(4 * Math.ceil((ToolResultProjection.MEDIA_MAX_BYTES + 1) / 3))}`,
    }], { image: true, pdf: true }, ToolResultProjection.createMediaBudget())
    expect(oversized.attachments).toHaveLength(0)
    expect(oversized.notices.join(" ")).toContain("过大")

    const unsupported = ToolResultProjection.projectMediaAttachments([small], {
      image: false, pdf: false,
    }, ToolResultProjection.createMediaBudget())
    expect(unsupported.attachments).toHaveLength(0)
    expect(unsupported.notices.join(" ")).toContain("不支持")
  })

  test("顶层 JSON 数组、Markdown 表格和重复日志保留可决策信息", async () => {
    const json = JSON.stringify(Array.from({ length: 1_000 }, (_, index) => ({
      method: index === 0 ? "ols_regression" : "spec",
      status: index === 0 ? "pass" : "ok",
      estimate: index === 0 ? 0.42 : index,
    })), null, 2)
    const jsonProjection = await ToolResultProjection.project({
      toolName: "experiment_log", title: "规格记录", output: json, metadata: {}, inputBudgetTokens: 32_000,
    })
    expect(jsonProjection.content).toContain("ols_regression")
    expect(jsonProjection.content).toContain("estimate")
    expect(jsonProjection.content).toContain("1000 items")

    const table = [
      "# 回归结果", "| variable | estimate | p_value |", "|---|---:|---:|",
      "| treat | 0.42 | 0.01 |", "| control | 0.13 | 0.20 |",
      ...Array.from({ length: 4_000 }, (_, index) => `ordinary paragraph ${index}`),
    ].join("\n")
    const tableProjection = await ToolResultProjection.project({
      toolName: "ols_regression", title: "OLS", output: table, metadata: {}, inputBudgetTokens: 32_000,
    })
    expect(tableProjection.content).toContain("| variable | estimate | p_value |")
    expect(tableProjection.content).toContain("| treat | 0.42 | 0.01 |")

    const logs = [
      "2026-08-24 14:30:00 INFO start", ...Array(30).fill("2026-08-24 14:31:00 ERROR connection reset"),
      "2026-08-24 15:00:00 WARN retry exhausted", "exit code: 1",
      ...Array.from({ length: 5_000 }, (_, index) => `debug ${index}`),
    ].join("\n")
    const logProjection = await ToolResultProjection.project({
      toolName: "bash", title: "命令", output: logs, metadata: {}, inputBudgetTokens: 32_000,
    })
    expect(logProjection.content).toContain("connection reset")
    expect(logProjection.content).toMatch(/重复|30/)
    expect(logProjection.content).toContain("exit code: 1")
  })

  test("导入结果的变量清单在长输出投影中保持可见", async () => {
    const output = [
      ...Array.from({ length: 12 }, (_, index) => `普通说明 ${index}`),
      "- 变量：year、地区、创新指数、高质量发展指数",
      ...Array.from({ length: 4_000 }, (_, index) => `普通细节 ${index}`),
    ].join("\n")
    const projected = await ToolResultProjection.project({
      toolName: "data_import",
      title: "数据导入",
      output,
      metadata: {},
      inputBudgetTokens: 32_000,
    })

    expect(projected.content).toContain("变量：year、地区、创新指数、高质量发展指数")
  })

  test("外部化写盘失败也必须保持批次硬预算", async () => {
    const persist = spyOn(Truncate, "persist").mockRejectedValue(new Error("disk full"))
    try {
      const items = Array.from({ length: 30 }, (_, index) => ({
        toolName: `tool_${index}`,
        content: "大量中文输出".repeat(1_000),
        fullOutput: "大量中文输出".repeat(1_000),
      }))
      const fitted = await ToolResultProjection.fitBatch(items, 600)
      expect(ToolResultProjection.estimateBatch(fitted)).toBeLessThanOrEqual(600)
      expect(fitted).toHaveLength(30)
    } finally {
      persist.mockRestore()
    }
  })
})
