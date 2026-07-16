import { describe, expect, test } from "bun:test"
import { buildAnalysisUserView, isAnalysisTurn, localizeAnalysisWarning } from "@/runtime/analysis-user-view"
import {
  containsEngineInternalData,
  sanitizeAnalysisAssistantText,
  userFacingAnalysisErrorText,
} from "@/runtime/analysis-text-sanitizer"
import * as analysisUserView from "@/runtime/analysis-user-view"

describe("analysis user view", () => {
  test("does not label an image attachment as a data-processing task", () => {
    const pendingTaskLabel = (analysisUserView as Record<string, any>).pendingTaskLabel

    expect(
      pendingTaskLabel?.({
        text: "帮我看看这张截图",
        files: [{ filename: "screen.png", url: "file:///screen.png", mime: "image/png" }],
      }),
    ).toBeUndefined()
    expect(pendingTaskLabel?.({ text: "再分析一遍，加入控制变量", files: [] })).toBe("正在进行计量分析")
  })

  test("ignores analysis words and data extensions inside image filenames", () => {
    const pendingTaskLabel = (analysisUserView as Record<string, any>).pendingTaskLabel

    expect(
      pendingTaskLabel?.({
        text: "看看这张图",
        files: [{ filename: "regression.csv.png", url: "file:///regression.csv.png", mime: "image/png" }],
      }),
    ).toBeUndefined()
  })

  test("does not show analysis progress for a negated analysis request", () => {
    const pendingTaskLabel = (analysisUserView as Record<string, any>).pendingTaskLabel

    expect(pendingTaskLabel?.({ text: "先别做回归，告诉我不同模型有什么区别", files: [] })).toBeUndefined()
  })

  test("does not show analysis progress for a method question", () => {
    const pendingTaskLabel = (analysisUserView as Record<string, any>).pendingTaskLabel

    expect(pendingTaskLabel?.({ text: "回归和面板模型有什么区别", files: [] })).toBeUndefined()
  })

  test("never renders model reasoning inside an analysis task", () => {
    const shouldShowReasoning = (analysisUserView as Record<string, any>).shouldShowReasoning

    expect(
      shouldShowReasoning?.({
        hasContent: true,
        showThinking: true,
        isAnalysis: true,
        waitingForAccess: false,
      }),
    ).toBe(false)
  })

  test("does not turn a conversational mention of data analysis into an analysis workflow", () => {
    expect(isAnalysisTurn([], "你除了做数据分析还可以干什么")).toBe(false)
  })

  test("uses actual analysis tool activity as the only analysis signal", () => {
    expect(
      isAnalysisTurn([
        {
          tool: "econometrics",
          state: { status: "completed" },
        },
      ]),
    ).toBe(true)
  })

  test("treats every independent PyFixest tool as analysis activity", () => {
    for (const tool of ["hdfe_regression", "did_static", "did2s", "did_event_study_saturated"]) {
      expect(isAnalysisTurn([{ tool, state: { status: "pending" } }])).toBe(true)
    }
  })

  test("uses the latest independent estimator result instead of tool-id priority", () => {
    const view = buildAnalysisUserView({
      tools: [
        {
          tool: "ols_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "regression",
                step: "ols_regression",
                results: [{ label: "系数", value: "1.00" }],
              },
            },
          },
        },
        {
          tool: "panel_fe_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "regression",
                step: "panel_fe_regression",
                results: [{ label: "系数", value: "2.00" }],
              },
            },
          },
        },
      ],
    })

    expect(view?.steps).toEqual(["panel_fe_regression"])
    expect(view?.results).toEqual([{ label: "系数", value: "2.00", visibility: undefined }])
  })

  test("localizes English diagnostics before they reach the user result", () => {
    expect(
      localizeAnalysisWarning("Breusch-Pagan is significant; use robust or clustered standard errors before reporting inference."),
    ).toBe("异方差检验显著，建议使用稳健或聚类标准误进行推断。")
  })

  test("never renders raw DSML tool calls as assistant text", () => {
    const rawToolCall = '<| DSML | tool_calls>\n<| DSML | invoke name="econometrics">\n<| DSML | parameter name="methodName">ols_regression<| DSML | parameter>\n</| DSML | tool_calls>'

    expect(containsEngineInternalData(rawToolCall)).toBe(true)
    expect(
      sanitizeAnalysisAssistantText({
        text: rawToolCall,
        tools: [{ tool: "econometrics", state: { status: "pending" } }],
      }).text,
    ).toBe("")
  })

  test("never renders verifier JSON, even when analysis details are requested", () => {
    const verifierResult = `<verifier_result>\n{"status":"pass","trustedArtifacts":["/private/path"]}\n</verifier_result>`

    expect(containsEngineInternalData(verifierResult)).toBe(true)
    expect(
      sanitizeAnalysisAssistantText({
        text: verifierResult,
        tools: [{ tool: "data_import", state: { status: "completed" } }],
        latestUserText: "展开分析过程",
      }).text,
    ).toBe("")
  })

  test("turns Python tracebacks into a short Chinese analysis failure", () => {
    const traceback = `Auto recommendation profiling failed: numpy boolean subtract\nTraceback (most recent call last):\n  File "/Users/cw/.killstata/runtime/tmp/econometrics.py", line 63\nTypeError: numpy boolean subtract`
    const visible = userFacingAnalysisErrorText(traceback)

    expect(visible).toBe("自动推荐未完成，未生成计量方案。请重试当前任务。")
    expect(visible).not.toContain("Traceback")
    expect(visible).not.toContain("/Users/")
  })

  test("sanitizes a Python traceback when it arrives as assistant text", () => {
    const traceback = `Auto recommendation profiling failed: numpy boolean subtract\nTraceback (most recent call last):\n  File "/Users/cw/.killstata/runtime/tmp/econometrics.py", line 63\nTypeError: numpy boolean subtract`
    const visible = sanitizeAnalysisAssistantText({
      text: traceback,
      tools: [{ tool: "econometrics", state: { status: "error" } }],
    }).text

    expect(visible).toBe("自动推荐未完成，未生成计量方案。请重试当前任务。")
    expect(visible).not.toContain("Traceback")
    expect(visible).not.toContain("/Users/")
  })
})
