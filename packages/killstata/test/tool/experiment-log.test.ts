import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { buildExperimentEntries, renderExperimentLog } from "@/tool/analysis-experiment-log"
import type { DatasetManifest } from "@/tool/analysis-state"

// 造一份真实形状的 manifest + results.json，验证日志能把「数据怎么变的」和
// 「结果怎么变的」正确串起来。这正是产品的核心叙事，不能靠人肉去核对。
function writeResults(dir: string, values: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, "results.json")
  fs.writeFileSync(p, JSON.stringify(values), "utf-8")
  return p
}

function makeManifest(root: string): DatasetManifest {
  // 实验 1：原始导入 220 行
  const run1 = writeResults(path.join(root, "run1"), {
    coefficient: 0.1167,
    std_error: 0.0113,
    p_value: 0.0021,
    r_squared: 0.7566,
    rows_used: 220,
    effective_method: "panel_fe",
  })
  // 实验 2：剔除部分年份后 160 行，结果变显著
  const run2 = writeResults(path.join(root, "run2"), {
    coefficient: 0.1452,
    std_error: 0.0089,
    p_value: 0.0003,
    r_squared: 0.81,
    rows_used: 160,
    effective_method: "panel_fe",
  })

  const spec = {
    dependentVar: "invest",
    treatmentVar: "value",
    covariates: ["capital"],
    entityVar: "firm",
    timeVar: "year",
    clusterVar: "firm",
  }

  return {
    version: 1,
    datasetId: "did_test01",
    sourcePath: "/tmp/grunfeld.csv",
    createdAt: "2026-07-13T10:00:00.000Z",
    updatedAt: "2026-07-13T12:00:00.000Z",
    stages: [
      {
        stageId: "stage_000",
        branch: "main",
        action: "import",
        workingPath: path.join(root, "stage_000.parquet"),
        workingFormat: "parquet",
        rowCount: 220,
        columnCount: 5,
        createdAt: "2026-07-13T10:00:00.000Z",
      },
      {
        stageId: "stage_001",
        parentStageId: "stage_000",
        branch: "main",
        action: "filter",
        label: "剔除 1935-1938",
        workingPath: path.join(root, "stage_001.parquet"),
        workingFormat: "parquet",
        rowCount: 160,
        columnCount: 5,
        createdAt: "2026-07-13T11:00:00.000Z",
      },
    ],
    artifacts: [
      {
        artifactId: "panel_fe_1",
        stageId: "stage_000",
        branch: "main",
        action: "panel_fe_regression",
        outputPath: run1,
        createdAt: "2026-07-13T10:30:00.000Z",
        metadata: { spec },
      },
      {
        artifactId: "panel_fe_2",
        stageId: "stage_001",
        branch: "main",
        action: "panel_fe_regression",
        outputPath: run2,
        createdAt: "2026-07-13T11:30:00.000Z",
        metadata: { spec },
      },
      // 推荐类产物不该被算作一次"实验"
      {
        artifactId: "auto_1",
        stageId: "stage_000",
        branch: "main",
        action: "auto_recommend",
        outputPath: path.join(root, "nonexistent.json"),
        createdAt: "2026-07-13T10:05:00.000Z",
      },
    ],
    finalOutputs: [],
  } as unknown as DatasetManifest
}

function withTemp<T>(fn: (root: string) => T) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-explog-"))
  try {
    return fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("experiment log", () => {
  test("counts only real estimations as experiments (auto_recommend is not one)", () => {
    withTemp((root) => {
      const entries = buildExperimentEntries(makeManifest(root))
      expect(entries).toHaveLength(2)
      expect(entries.map((e) => e.index)).toEqual([1, 2])
    })
  })

  test("pulls the grounded numbers out of results.json rather than inventing them", () => {
    withTemp((root) => {
      const [first, second] = buildExperimentEntries(makeManifest(root))
      expect(first.coefficient).toBeCloseTo(0.1167, 4)
      expect(first.pValue).toBeCloseTo(0.0021, 4)
      expect(second.coefficient).toBeCloseTo(0.1452, 4)
      expect(second.rowsUsed).toBe(160)
    })
  })

  test("links each experiment to the data stage it ran on, including the sample change", () => {
    withTemp((root) => {
      const [, second] = buildExperimentEntries(makeManifest(root))
      // 实验 2 跑在 stage_001 上，它的父阶段是 220 行 → 现在 160 行
      expect(second.stageId).toBe("stage_001")
      expect(second.stageLabel).toBe("剔除 1935-1938")
      expect(second.rowCount).toBe(160)
      expect(second.parentRowCount).toBe(220)
    })
  })

  test("the rendered log tells the story: what was dropped, and how the result moved", () => {
    withTemp((root) => {
      const entries = buildExperimentEntries(makeManifest(root))
      const md = renderExperimentLog({ datasetId: "did_test01", entries })

      // 数据怎么变的
      expect(md).toContain("剔除 1935-1938")
      expect(md).toContain("220 → 160 行（−60）")

      // 结果怎么变的（这是用户最关心的那句话）
      expect(md).toContain("系数 0.1167 → **0.1452**")
      expect(md).toContain("更显著")

      // 显著性星号
      expect(md).toContain("***")

      // 设定汇总表：所有尝试并排，一眼看出结论对设定有多敏感
      expect(md).toContain("## 设定汇总")

      // 诚实性提醒必须在，这是这个功能存在的前提
      expect(md).toContain("p-hacking")
    })
  })

  test("an empty dataset renders a log instead of crashing", () => {
    const md = renderExperimentLog({ datasetId: "did_empty", entries: [] })
    expect(md).toContain("尚未运行任何回归")
  })

  // 下面两条是端到端实跑时才暴露出来的——单测里用的"漂亮"数字碰不到。

  test("significance stars do not collide with markdown emphasis", () => {
    const entries = [
      { index: 1, createdAt: "t", method: "panel_fe", coefficient: 0.1, stdError: 0.01, pValue: 0.00001 },
    ]
    const md = renderExperimentLog({ datasetId: "d", entries: entries as any })

    // 曾经的 bug：用 **${star}** 包裹三颗星，渲染出 `*******` 七颗
    expect(md).not.toContain("*******")
    expect(md).toContain("p = <0.0001 ***")
  })

  test("two p-values that are indistinguishable at reporting precision are not ranked against each other", () => {
    // 两次 p 都极小（底层浮点不同，但报告出来都是 <0.0001）
    const entries = [
      { index: 1, createdAt: "t1", method: "panel_fe", coefficient: 0.1167, stdError: 0.0113, pValue: 1e-15 },
      { index: 2, createdAt: "t2", method: "panel_fe", coefficient: 0.1426, stdError: 0.0217, pValue: 1e-10 },
    ]
    const md = renderExperimentLog({ datasetId: "d", entries: entries as any })

    // 曾经的 bug：拿 1e-10 > 1e-15 判定"更不显著"，而用户看到的两个值明明都是 <0.0001
    expect(md).not.toContain("更不显著")
    expect(md).toContain("显著性相当")
  })
})
