import { describe, expect, test } from "bun:test"
import {
  buildAnalysisUserView,
  displayStepLabel,
  isAnalysisTurn,
  localizeAnalysisWarning,
  maybeBuildAnalysisUserViewTexts,
} from "@/runtime/analysis-user-view"
import {
  containsEngineInternalData,
  sanitizeAnalysisAssistantText,
  userFacingAnalysisErrorText,
} from "@/runtime/analysis-text-sanitizer"
import * as analysisUserView from "@/runtime/analysis-user-view"
import { analysisMetric, importDisplayFile } from "@/tool/analysis-user-view"

describe("analysis user view", () => {
  test("导入结果优先显示用户文件名，不暴露受管快照中的数据集 ID", () => {
    expect(importDisplayFile({
      originalFilename: "did.xlsx",
      sourcePath: "/tmp/.killstata/datasets/prt_internal-did.xlsx",
      fallbackPath: "/tmp/.killstata/datasets/prt_internal/original.xlsx",
    })).toBe("did.xlsx")
  })

  test("用户视图中的极小 p 值不显示为精确零", () => {
    expect(analysisMetric("p 值", "0.0000")?.value).toBe("<0.001")
    expect(analysisMetric("p 值", "0.0421")?.value).toBe("0.042")
  })

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

  test("renders model reasoning inside an analysis task when showThinking is enabled", () => {
    const shouldShowReasoning = (analysisUserView as Record<string, any>).shouldShowReasoning

    expect(
      shouldShowReasoning?.({
        hasContent: true,
        showThinking: true,
        isAnalysis: true,
        waitingForAccess: false,
      }),
    ).toBe(true)
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

  test("uses Chinese names for every model-visible PSM estimator", () => {
    expect(displayStepLabel("psm_ipw")).toBe("逆概率加权")
    expect(displayStepLabel("psm_regression")).toBe("倾向得分回归调整")
    expect(displayStepLabel("psm_double_robust")).toBe("双重稳健 AIPW")
  })

  test("PSM 构造诊断后不声称已检查协变量平衡", () => {
    const view = buildAnalysisUserView({
      tools: [{
        tool: "psm_construction",
        state: {
          status: "completed",
          metadata: { analysisView: { kind: "econometrics", step: "psm_construction", results: [] } },
        },
      }],
    })

    expect(view?.nextStep).toContain("处理前协变量时点")
    expect(view?.nextStep).toContain("匹配或加权后")
    expect(view?.nextStep).not.toContain("先检查共同支撑与协变量平衡")
  })

  test("方法推荐步骤不能在用户界面显示成已经执行回归", () => {
    expect(displayStepLabel("econometrics(recommendation)")).toBe("计量方法推荐")
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

  test("结果兜底摘要不因指标上限丢掉固定效应规格", () => {
    const view = buildAnalysisUserView({
      tools: [{
        tool: "hdfe_regression",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "hdfe_regression",
              results: [
                { label: "绿色信贷 系数", value: "1.35" },
                { label: "标准误", value: "0.12" },
                { label: "p 值", value: "<0.001" },
                { label: "95% 置信区间", value: "[1.1, 1.6]" },
                { label: "协方差", value: "clustered" },
                { label: "N", value: "9545" },
                { label: "R²", value: "0.96" },
                { label: "组内 R²", value: "0.84" },
                { label: "固定效应", value: "地区、年份" },
              ],
            },
          },
        },
      }],
    })

    expect(view?.results).toEqual(expect.arrayContaining([
      { label: "固定效应", value: "地区、年份", visibility: undefined },
    ]))
  })

  test("估计结果保留并显示待核验状态", () => {
    const view = buildAnalysisUserView({
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          metadata: {
            verifierPending: true,
            analysisView: {
              kind: "regression",
              step: "ols_regression",
              results: [{ label: "系数", value: "1.00" }],
            },
          },
        },
      }],
    })

    expect(view?.results).toEqual([{ label: "系数", value: "1.00", visibility: undefined }])
    expect(view?.warnings).toContain("估计结果已生成，状态：待核验；核验完成前请勿将其作为最终结论。")
  })

  test("独立核验阻断后保留结果并明确标为不可作为最终结论", () => {
    const view = buildAnalysisUserView({
      tools: [{
        tool: "ols_regression",
        state: {
          status: "completed",
          metadata: {
            verifierStatus: "block",
            analysisView: {
              kind: "regression", step: "ols_regression",
              results: [{ label: "系数", value: "1.00" }],
            },
          },
        },
      }],
    })

    expect(view?.results).toEqual([{ label: "系数", value: "1.00", visibility: undefined }])
    expect(view?.warnings).toContain("独立核验未通过；估计结果保留，但不可作为最终结论。")
  })

  test("没有模型收尾时，兜底摘要仍分别交付同一轮完成的多个估计器", () => {
    const views = maybeBuildAnalysisUserViewTexts({
      tools: [
        {
          tool: "data_import",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "data_import",
                step: "data_import(import)",
                foundInputFile: "did.xlsx",
              },
            },
          },
        },
        {
          tool: "ols_regression",
          state: {
            status: "completed",
            metadata: {
              analysisView: {
                kind: "regression",
                step: "ols_regression",
                results: [{ label: "系数", value: "0.85" }],
                conclusion: "OLS 已完成。",
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
                results: [{ label: "系数", value: "0.86" }],
                conclusion: "固定效应回归已完成。",
              },
            },
          },
        },
      ],
      latestUserText: "先做OLS，再做双向固定效应面板回归",
    })

    expect(views).toHaveLength(2)
    expect(views.map((item) => item.view.steps)).toEqual([
      ["ols_regression"],
      ["panel_fe_regression"],
    ])
    expect(views.map((item) => item.text)).toEqual([
      expect.stringContaining("系数 0.85"),
      expect.stringContaining("系数 0.86"),
    ])
  })

  test("推荐结果的面板与重复键事实进入用户可见摘要", () => {
    const result = analysisUserView.maybeBuildAnalysisUserViewText({
      tools: [{
        tool: "econometrics_recommend",
        state: {
          status: "completed",
          metadata: {
            analysisView: {
              kind: "econometrics",
              step: "econometrics(recommendation)",
              results: [
                { label: "数据结构", value: "面板数据" },
                { label: "重复实体-时间键", value: "115" },
              ],
              conclusion: "执行具体方法前仍需确认研究设计。",
            },
          },
        },
      }],
    })

    expect(result?.text).toContain("面板数据")
    expect(result?.text).toContain("重复实体-时间键 115")
    expect(result?.text).toContain("计量方法推荐")
  })

  test("localizes English diagnostics before they reach the user result", () => {
    expect(
      localizeAnalysisWarning(
        "Breusch-Pagan is significant; use robust or clustered standard errors before reporting inference.",
      ),
    ).toBe("异方差检验显著，建议使用稳健或聚类标准误进行推断。")

    expect(localizeAnalysisWarning("Found 115 duplicate entity-time rows")).toContain(
      "不等于完整数据行重复",
    )
  })

  test("保留带英文变量名的中文质量事实，不降级成泛化提醒", () => {
    expect(localizeAnalysisWarning("质量检查事实：缺失：time缺失3043行；重复键检查：已验证地区×year唯一；异常值：人口密度存在提醒"))
      .toContain("time缺失3043行")
    expect(localizeAnalysisWarning("质量检查事实：缺失：time缺失3043行；重复键检查：已验证地区×year唯一；异常值：人口密度存在提醒"))
      .not.toBe("检测到需要关注的诊断问题，请查看结果文件中的诊断说明。")
  })

  test("never renders raw DSML tool calls as assistant text", () => {
    const rawToolCall =
      '<| DSML | tool_calls>\n<| DSML | invoke name="econometrics">\n<| DSML | parameter name="methodName">ols_regression<| DSML | parameter>\n</| DSML | tool_calls>'

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
