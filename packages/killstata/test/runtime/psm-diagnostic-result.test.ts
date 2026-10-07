import { describe, expect, test } from "bun:test"
import { buildEngineToolResult } from "@/runtime/services/econometrics-engine-result"

describe("PSM 诊断结果回投", () => {
  test("倾向得分构造回传共同支撑诊断与分数产物，不伪装为效应估计", () => {
    const result = buildEngineToolResult({
      methodID: "psm_construction",
      datasetId: "dataset_nsw",
      stageId: "stage_000",
      methodArguments: {
        treatmentVar: "treat",
        analysisUnitVar: "unit_id",
        covariates: ["age", "age_squared", "education", "black", "hispanic", "nodegree"],
      },
      payload: {
        success: true,
        method: "psm_construction",
        rowsInput: 445,
        rowsUsed: 445,
        scoreMin: 0.23537249077135727,
        scoreMax: 0.6379746560895533,
        meanTreated: 0.43409935497023505,
        meanControl: 0.40266007434810186,
        extremeScoreShare: 0,
        supportLower: 0.23828173584817436,
        supportUpper: 0.6292688485070604,
        shareInSupport: 0.9932584269662922,
        logitIterations: 5,
        warnings: ["只有 99.3% 的样本位于经验共同支撑区间，估计效应前必须先处理重叠问题"],
        propensityScoresPath: ".killstata/psm_construction/propensity_scores.csv",
        resultPath: ".killstata/psm_construction/results.json",
      },
      artifacts: [
        { kind: "propensity_scores", path: ".killstata/psm_construction/propensity_scores.csv" },
        { kind: "result", path: ".killstata/psm_construction/results.json" },
      ],
    })

    expect(result.title).toBe("倾向得分构造诊断")
    expect(result.output).toContain("倾向得分范围：[0.2354, 0.6380]")
    expect(result.output).toContain("共同支撑区间：[0.2383, 0.6293]")
    expect(result.output).toContain("共同支撑覆盖率：99.3%")
    expect(result.output).toContain("处理组平均倾向得分：0.4341")
    expect(result.output).toContain("对照组平均倾向得分：0.4027")
    expect(result.output).toContain("估计效应前必须先处理重叠问题")
    expect(result.output).toContain("不是处理效应估计")
    expect(result.output).not.toContain("psm_construction")
    expect(result.output).not.toContain(".killstata/")
    expect(result.metadata.analysisView.results).toEqual(expect.arrayContaining([
      { label: "倾向得分范围", value: "[0.2354, 0.6380]", visibility: undefined },
      { label: "共同支撑覆盖率", value: "99.3%", visibility: undefined },
      { label: "有效样本", value: "445", visibility: undefined },
    ]))
    expect(result.metadata.analysisView.conclusion).toContain("不是处理效应估计")
    expect(result.metadata.analysisView.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "倾向得分明细", visibility: "user_default" }),
    ]))
  })

  test("分布可视化以中文呈现两组样本和共同支撑图", () => {
    const result = buildEngineToolResult({
      methodID: "psm_visualize",
      payload: {
        success: true,
        method: "psm_visualize",
        rowsInput: 445,
        rowsUsed: 445,
        scoreMin: 0.23537249077135727,
        scoreMax: 0.6379746560895533,
        meanTreated: 0.43409935497023505,
        meanControl: 0.40266007434810186,
        extremeScoreShare: 0,
        supportLower: 0.23828173584817436,
        supportUpper: 0.6292688485070604,
        shareInSupport: 0.9932584269662922,
        treatedCount: 185,
        controlCount: 260,
        warnings: ["只有 99.3% 的样本位于经验共同支撑区间，估计效应前必须先处理重叠问题"],
        plotPath: ".killstata/psm_visualize/ps_distribution.png",
        resultPath: ".killstata/psm_visualize/results.json",
      },
      artifacts: [
        { kind: "plot", path: ".killstata/psm_visualize/ps_distribution.png" },
        { kind: "result", path: ".killstata/psm_visualize/results.json" },
      ],
    })

    expect(result.title).toBe("倾向得分分布诊断")
    expect(result.output).toContain("处理组样本量：185")
    expect(result.output).toContain("对照组样本量：260")
    expect(result.output).toContain("倾向得分分布图已生成")
    expect(result.output).not.toContain("psm_visualize")
    expect(result.output).not.toContain(".killstata/")
    expect(result.metadata.analysisView.results).toEqual(expect.arrayContaining([
      { label: "处理组样本量", value: "185", visibility: undefined },
      { label: "对照组样本量", value: "260", visibility: undefined },
      { label: "共同支撑覆盖率", value: "99.3%", visibility: undefined },
    ]))
    expect(result.metadata.analysisView.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "倾向得分分布图", visibility: "user_default" }),
    ]))
  })
})
