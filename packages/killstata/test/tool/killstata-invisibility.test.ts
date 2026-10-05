import { describe, expect, test } from "bun:test"
import { displayPath, renderToolDisplay } from "@/tool/analysis-display"
import { buildAnalysisUserView, renderAnalysisUserView } from "@/runtime/analysis-user-view"
import { createToolAnalysisView, analysisArtifact, analysisMetric } from "@/tool/analysis-user-view"
import { sanitizeAnalysisAssistantText } from "@/runtime/analysis-text-sanitizer"

// ── 用户不可感知 .killstata 的契约测试 ──
// 用户是非开发人员，任何用户可见渲染（TUI 工具标题、展开分析过程、转录导出）
// 都不得出现 .killstata 目录结构或内部 ID（datasetId/stageId/workflowRunId）。

describe("displayPath hides internal workspace", () => {
  const cases: Array<[string, string]> = [
    // [输入路径, 期望输出] —— 只显示文件名/末段，不暴露 .killstata 前缀链
    ["/Users/me/proj/.killstata/econometrics/ols/run_abc/ols_result.json", "ols_result.json"],
    ["/Users/me/proj/.killstata/econometrics/ols/run_abc", "run_abc"],
    ["./.killstata/datasets/did/input.csv", "input.csv"],
    ["../proj/.killstata/runtime/reflection/x.json", "x.json"],
    ["/Users/me/proj/.killstata", ""], // 内部工作区目录本身：无可暴露文件名
    // 用户自己的文件不受影响（相对路径保持可追踪）
    ["data/did.xlsx", "data/did.xlsx"],
  ]

  for (const [input, expected] of cases) {
    test(`hides ${input}`, () => {
      expect(displayPath(input)).toBe(expected)
    })
  }

  test("name mode still returns basename", () => {
    expect(displayPath("/Users/me/proj/.killstata/x/y.json", "name")).toBe("y.json")
  })
})

describe("renderToolDisplay never leaks internal paths", () => {
  const metadata = {
    display: {
      summary: "模型结果",
      details: ["行数：100"],
      artifacts: [
        { label: "完整结果", path: "/Users/me/proj/.killstata/econometrics/ols/run_1/ols_result.json" },
        { label: "用户文件", path: "data/did.xlsx" },
      ],
    },
  }

  test("artifacts render without .killstata", () => {
    const text = renderToolDisplay(metadata, { includeArtifacts: true, pathMode: "relative" })
    expect(text).toBeTruthy()
    expect(text).not.toContain(".killstata")
    expect(text).not.toContain("/Users/me")
    expect(text).toContain("ols_result.json")
    expect(text).toContain("data/did.xlsx") // 用户文件保持相对路径可追踪
  })
})

describe("analysis user view never leaks internal IDs", () => {
  function part(tool: string, metadata: Record<string, unknown>, status = "completed") {
    return { tool, state: { status, metadata } }
  }

  const importView = createToolAnalysisView({
    kind: "data_import",
    step: "data_import(import)",
    datasetId: "dataset_abc123",
    stageId: "stage_42",
    artifacts: [analysisArtifact("/Users/me/proj/.killstata/datasets/did/stage_42/working.parquet", { label: "当前阶段数据" })],
    results: [analysisMetric("行数", 100)],
  })

  const estimateView = createToolAnalysisView({
    kind: "econometrics",
    step: "ols_regression",
    datasetId: "dataset_abc123",
    stageId: "stage_99",
    results: [analysisMetric("系数", "1.23")],
    artifacts: [analysisArtifact("/Users/me/proj/.killstata/econometrics/ols/run_9/ols_result.json")],
  })

  const parts = [
    part("data_import", { analysisView: importView }),
    part("econometrics", { analysisView: estimateView }),
  ]

  test("built view keeps IDs for grounding but rendered text hides them", () => {
    const view = buildAnalysisUserView({ tools: parts })
    expect(view).toBeTruthy()
    // 模型 grounding 需要 ID（元数据层），但渲染文本绝不能出现
    const text = renderAnalysisUserView(view!)
    expect(text).not.toContain("dataset_abc123")
    expect(text).not.toContain("stage_42")
    expect(text).not.toContain("stage_99")
    expect(text).not.toContain(".killstata")
    expect(text).not.toContain("/Users/me")
  })
})

describe("model-reply sanitizer covers nested and prefix forms", () => {
  const analysisTools = [{ tool: "data_import", state: { status: "completed", metadata: {} } }]

  test("nested packages/killstata/.killstata path is replaced, numbers preserved", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "结果保存在 packages/killstata/.killstata/datasets/ds_abc/econometrics/ols/ols_result.json，系数 0.31。",
      tools: analysisTools,
    })
    expect(result.sanitized).toBe(true)
    expect(result.text).not.toContain(".killstata")
    expect(result.text).not.toContain("ols_result.json")
    expect(result.text).toContain("0.31")
  })

  test("./.killstata relative form is replaced", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据在 ./.killstata/datasets/did/input.csv，已导入。",
      tools: analysisTools,
    })
    expect(result.sanitized).toBe(true)
    expect(result.text).not.toContain(".killstata")
  })

  test("a filename like foo.killstata/data.csv is NOT treated as internal workspace", () => {
    // 负后视断言：.killstata 前是字母时不匹配，避免把合法文件名误判为内部路径
    const result = sanitizeAnalysisAssistantText({
      text: "参考文件在 foo.killstata/data.csv，其余正常。",
      tools: analysisTools,
    })
    expect(result.sanitized).toBe(false)
    expect(result.text).toContain("foo.killstata/data.csv")
  })

  test("unchanged analysis-turn text is not flagged as sanitized", () => {
    const result = sanitizeAnalysisAssistantText({
      text: "数据已导入，共 1240 行，变量有 age、income。",
      tools: analysisTools,
    })
    expect(result.sanitized).toBe(false)
    expect(result.text).toContain("1240")
  })
})
