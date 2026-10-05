import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  createEconometricsNumericSnapshot,
  numericSnapshotFromAnalysisView,
  recoverNumericSnapshots,
  rewriteGroundedText,
  validateNumericGrounding,
  type NumericSnapshotDocument,
} from "../../src/tool/analysis-grounding"

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "killstata-grounding-"))
}

describe("tool.analysis_grounding", () => {
  test("把工具生成的用户视图指标作为数值核验补充源", () => {
    const snapshot = numericSnapshotFromAnalysisView({
      tool: "ols_regression",
      view: {
        kind: "econometrics",
        step: "ols_regression",
        results: [
          { label: "高质量发展指数 系数", value: "0.8502" },
          { label: "标准误", value: "0.0016" },
          { label: "N", value: "4709" },
          { label: "R²", value: "0.9895" },
        ],
      },
    })

    expect(snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "coefficient", term: "高质量发展指数", value: 0.8502 }),
      expect.objectContaining({ metric: "std_error", term: "primary", value: 0.0016 }),
      expect.objectContaining({ metric: "n_obs", term: "primary", value: 4709 }),
      expect.objectContaining({ metric: "r_squared", term: "model", value: 0.9895 }),
    ]))
  })

  test("analysisView 中的系数项数不进入 coefficient 快照", () => {
    const snapshot = numericSnapshotFromAnalysisView({
      tool: "panel_fe_regression",
      view: {
        kind: "econometrics",
        results: [
          { label: "系数项", value: "4" },
          { label: "绿色信贷 系数", value: "1.35" },
        ],
      },
    })

    expect(snapshot.entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "coefficient", value: 4 }),
    ]))
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "coefficient", term: "绿色信贷", value: 1.35 }),
    ]))
  })

  test("接受 GLM runner 产生的 camelCase 系数表", () => {
    const root = makeTempDir()
    try {
      const outputDir = path.join(root, "analysis", "logit_regression")
      fs.mkdirSync(outputDir, { recursive: true })
      const coefficientsPath = path.join(outputDir, "coefficients.csv")
      fs.writeFileSync(
        coefficientsPath,
        ["term,estimate,stdError,pValue,confLow,confHigh", "x,0.52,0.11,0.001,0.30,0.74"].join("\n"),
        "utf-8",
      )

      const snapshot = createEconometricsNumericSnapshot({
        outputDir,
        methodName: "logit_regression",
        result: {},
        coefficientsPath,
      })

      expect(snapshot.entries.some((entry) => entry.metric === "coefficient" && entry.value === 0.52)).toBe(true)
      expect(snapshot.entries.some((entry) => entry.metric === "p_value" && entry.value === 0.001)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("builds econometrics numeric snapshot for non-panel outputs", () => {
    const root = makeTempDir()
    try {
      const outputDir = path.join(root, "analysis", "ols_regression")
      fs.mkdirSync(outputDir, { recursive: true })
      const coefficientsPath = path.join(outputDir, "coefficient_table.csv")
      fs.writeFileSync(
        coefficientsPath,
        ["term,coefficient,std_error,t_stat,p_value,ci_lower,ci_upper", "x,0.52,0.11,4.73,0.001,0.30,0.74"].join("\n"),
        "utf-8",
      )
      const diagnosticsPath = path.join(outputDir, "diagnostics.json")
      fs.writeFileSync(
        diagnosticsPath,
        JSON.stringify({
          residuals: { mean: 0.0, std: 0.8, min: -1.5, max: 1.7 },
          heteroskedasticity: { breusch_pagan_pvalue: 0.42 },
        }),
        "utf-8",
      )
      const metadataPath = path.join(outputDir, "model_metadata.json")
      fs.writeFileSync(
        metadataPath,
        JSON.stringify({
          rows_used: 120,
        }),
        "utf-8",
      )

      const snapshot = createEconometricsNumericSnapshot({
        outputDir,
        methodName: "ols_regression",
        result: {
          outcomeMean: 1.23,
          coefficient: 0.52,
          std_error: 0.11,
          p_value: 0.001,
          fPValue: 0.00001,
          r_squared: 0.64,
          output_path: path.join(outputDir, "results.json"),
          treatment_var: "x",
        },
        coefficientsPath,
        diagnosticsPath,
        metadataPath,
        datasetId: "dataset_ols",
        stageId: "stage_001",
        runId: "run_20260330_test",
      })

      expect(fs.existsSync(snapshot.snapshotPath)).toBe(true)
      expect(snapshot.entries.some((entry) => entry.metric === "coefficient" && entry.term === "x")).toBe(true)
      expect(snapshot.entries.some((entry) => entry.metric === "n_obs" && entry.term === "rows_used")).toBe(true)
      expect(snapshot.entries.some((entry) => entry.metric === "mean" && entry.term === "结果变量" && entry.value === 1.23)).toBe(true)
      expect(snapshot.entries.some((entry) => entry.metric === "p_value" && entry.term === "F" && entry.value === 0.00001)).toBe(true)
      expect(snapshot.entries.some((entry) => entry.metric === "p_value" && entry.term === "breusch_pagan")).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("numeric snapshots reject a leaf symlink instead of overwriting its target", () => {
    const root = makeTempDir()
    try {
      const outputDir = path.join(root, "analysis", "heterogeneity")
      fs.mkdirSync(outputDir, { recursive: true })
      const outside = path.join(root, "outside-snapshot.json")
      fs.writeFileSync(outside, "keep external snapshot", "utf-8")
      fs.symlinkSync(outside, path.join(outputDir, "numeric_snapshot.json"))

      let error: unknown
      try {
        createEconometricsNumericSnapshot({
          outputDir,
          methodName: "heterogeneity_fe",
          result: { coefficient: 0.5, std_error: 0.1, p_value: 0.01, r_squared: 0.8, rows_used: 20 },
        })
      } catch (caught) {
        error = caught
      }

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("符号链接")
      expect(fs.readFileSync(outside, "utf-8")).toBe("keep external snapshot")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("recovers trusted numeric sources from explicitly read structured artifacts", async () => {
    const root = makeTempDir()
    try {
      const coeffPath = path.join(root, "coefficient_table.csv")
      fs.writeFileSync(
        coeffPath,
        ["term,coefficient,std_error,p_value,ci_lower,ci_upper", "did,0.52,0.11,0.001,0.30,0.74"].join("\n"),
        "utf-8",
      )
      const diagnosticsPath = path.join(root, "diagnostics.json")
      fs.writeFileSync(
        diagnosticsPath,
        JSON.stringify({
          heteroskedasticity: { breusch_pagan_pvalue: 0.42 },
        }),
        "utf-8",
      )

      const recovered = await recoverNumericSnapshots({
        snapshots: [],
        trustedArtifactPaths: [],
        explicitReadPaths: [coeffPath, diagnosticsPath],
      })

      const entries = recovered.snapshots.flatMap((snapshot) => snapshot.entries)
      expect(recovered.recovered).toBe(true)
      expect(
        entries.some((entry) => entry.metric === "coefficient" && entry.term === "did" && entry.value === 0.52),
      ).toBe(true)
      expect(
        entries.some((entry) => entry.metric === "p_value" && entry.term === "breusch_pagan" && entry.value === 0.42),
      ).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("partially grounded text is rewritten instead of fully refused", () => {
    const snapshot: NumericSnapshotDocument = {
      version: 1,
      sourceTool: "econometrics",
      scope: "regression",
      generatedAt: new Date().toISOString(),
      snapshotPath: "numeric_snapshot.json",
      entries: [
        {
          metric: "coefficient",
          scope: "regression",
          term: "x",
          value: 0.52,
          display: "0.520000",
          sourcePath: "numeric_snapshot.json",
          significance: "***",
        },
        {
          metric: "p_value",
          scope: "diagnostics",
          term: "x",
          value: 0.001,
          display: "0.001000",
          sourcePath: "numeric_snapshot.json",
        },
      ],
    }

    const text = [
      "Baseline estimate:",
      "- The coefficient on x is 0.52.",
      "- The p-value on x is 0.20.",
      "- The estimated effect is positive.",
    ].join("\n")

    const grounding = validateNumericGrounding({
      text,
      snapshots: [snapshot],
    })
    const rewritten = rewriteGroundedText({
      text,
      grounding,
    })

    expect(grounding.status).toBe("partial")
    expect(rewritten).toContain("The coefficient on x is 0.52.")
    expect(rewritten).toContain("未核验的精确统计数值已省略")
    expect(rewritten).toContain("部分统计表述无法与结果产物直接对应，已不纳入本次结论")
    expect(rewritten).not.toContain("I cannot report statistical numbers")
  })

  test("常见的结果变量均值与 p 值阈值表达不会误删已核验结果", () => {
    const snapshot: NumericSnapshotDocument = {
      version: 1,
      sourceTool: "econometrics",
      scope: "regression",
      generatedAt: new Date().toISOString(),
      snapshotPath: "numeric_snapshot.json",
      entries: [
        {
          metric: "n_obs",
          scope: "regression",
          term: "rows_used",
          value: 4709,
          display: "4709",
          sourcePath: "numeric_snapshot.json",
        },
        {
          metric: "mean",
          scope: "regression",
          term: "结果变量",
          value: 0.123,
          display: "0.123000",
          sourcePath: "numeric_snapshot.json",
        },
        {
          metric: "r_squared",
          scope: "regression",
          term: "model",
          value: 0.9895,
          display: "0.989500",
          sourcePath: "numeric_snapshot.json",
        },
        {
          metric: "coefficient",
          scope: "regression",
          term: "x",
          value: 0.8502,
          display: "0.850200",
          sourcePath: "numeric_snapshot.json",
        },
        {
          metric: "p_value",
          scope: "regression",
          term: "x",
          value: 0.00001,
          display: "0.000010",
          sourcePath: "numeric_snapshot.json",
        },
        {
          metric: "p_value",
          scope: "diagnostics",
          term: "F",
          value: 0.00001,
          display: "0.000010",
          sourcePath: "numeric_snapshot.json",
        },
      ],
    }
    const text = [
      "有效样本：4709；结果变量均值：0.123",
      "R²：0.9895；调整 R²：0.9895",
      "核心解释变量系数为 0.8502，p值<0.001",
    ].join("\n")

    const grounding = validateNumericGrounding({ text, snapshots: [snapshot] })
    expect(grounding.status).toBe("pass")
    expect(rewriteGroundedText({ text, grounding })).toBe(text)
  })
})
