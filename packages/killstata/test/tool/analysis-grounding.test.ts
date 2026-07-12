import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  createEconometricsNumericSnapshot,
  recoverNumericSnapshots,
  rewriteGroundedText,
  validateNumericGrounding,
  type NumericSnapshotDocument,
} from "../../src/tool/analysis-grounding"

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "killstata-grounding-"))
}

describe("tool.analysis_grounding", () => {
  test("builds econometrics numeric snapshot for non-panel outputs", () => {
    const root = makeTempDir()
    try {
      const outputDir = path.join(root, "analysis", "ols_regression")
      fs.mkdirSync(outputDir, { recursive: true })
      const coefficientsPath = path.join(outputDir, "coefficient_table.csv")
      fs.writeFileSync(
        coefficientsPath,
        [
          "term,coefficient,std_error,t_stat,p_value,ci_lower,ci_upper",
          "x,0.52,0.11,4.73,0.001,0.30,0.74",
        ].join("\n"),
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
          coefficient: 0.52,
          std_error: 0.11,
          p_value: 0.001,
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
      expect(snapshot.entries.some((entry) => entry.metric === "p_value" && entry.term === "breusch_pagan")).toBe(true)
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
        [
          "term,coefficient,std_error,p_value,ci_lower,ci_upper",
          "did,0.52,0.11,0.001,0.30,0.74",
        ].join("\n"),
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
      expect(entries.some((entry) => entry.metric === "coefficient" && entry.term === "did" && entry.value === 0.52)).toBe(true)
      expect(entries.some((entry) => entry.metric === "p_value" && entry.term === "breusch_pagan" && entry.value === 0.42)).toBe(true)
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
    expect(rewritten).toContain("Exact statistical values are omitted here because they were not verified against grounded outputs.")
    expect(rewritten).toContain("Unverified statistics omitted: p_value.")
    expect(rewritten).not.toContain("I cannot report statistical numbers")
  })
})
