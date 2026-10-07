/**
 * analysis-state.ts 公开符号的"存在性"快照测试。
 *
 * 这是 anti-rotation 网：防止有人误删/重命名 export 而没人发现。
 * **只断言"名字还在"，不验证签名正确、函数可调用、返回有意义。**
 * 真正的契约测试应在调用方 + 端到端测试中覆盖（参见 test/tool/*-golden.test.ts）。
 *
 * 行为修改的敏感点由 dependency 反转保护（B3 重构后的 `@/runtime/dataset-state`
 * 才是 runtime/session 的真正依赖源；`@/tool/analysis-state` 仅 re-export）。
 */

import { describe, expect, it } from "bun:test"
import * as analysisState from "../../src/tool/analysis-state"

// ── 测试：所有公开 export 存在且可 import ──────────────────────────────

describe("analysis-state facade", () => {
  it("exports all value re-exports from dataset-state", () => {
    expect(analysisState.projectRoot).toBeDefined()
    expect(analysisState.projectInternalRoot).toBeDefined()
    expect(analysisState.projectStateRoot).toBeDefined()
    expect(analysisState.projectReflectionRoot).toBeDefined()
    expect(analysisState.datasetsRoot).toBeDefined()
    expect(analysisState.datasetRoot).toBeDefined()
    expect(analysisState.datasetManifestPath).toBeDefined()
    expect(analysisState.datasetIndexPath).toBeDefined()
    expect(analysisState.inferSourceFormat).toBeDefined()
    expect(analysisState.getStage).toBeDefined()
    expect(analysisState.readDatasetManifest).toBeDefined()
    expect(analysisState.readDatasetIndex).toBeDefined()
  })

  it("exports all local functions", () => {
    expect(analysisState.createDatasetId).toBeFunction()
    expect(analysisState.normalizeRunId).toBeFunction()
    expect(analysisState.createRunId).toBeFunction()
    expect(analysisState.inferRunId).toBeFunction()
    expect(analysisState.buildStageId).toBeFunction()
    expect(analysisState.stageIndex).toBeFunction()
    expect(analysisState.projectPlansRoot).toBeFunction()
    expect(analysisState.sourceOutputsRoot).toBeFunction()
    expect(analysisState.runOutputsRoot).toBeFunction()
    expect(analysisState.deliveryStateRoot).toBeFunction()
    expect(analysisState.deliveryBundleName).toBeFunction()
    expect(analysisState.deliveryBundleDir).toBeFunction()
    expect(analysisState.projectTempRoot).toBeFunction()
    expect(analysisState.projectErrorsRoot).toBeFunction()
    expect(analysisState.projectHealthRoot).toBeFunction()
    expect(analysisState.ensureInternalLayout).toBeFunction()
    expect(analysisState.ensureDatasetDirs).toBeFunction()
    expect(analysisState.createDatasetManifest).toBeFunction()
    expect(analysisState.writeDatasetManifest).toBeFunction()
    expect(analysisState.writeDatasetIndex).toBeFunction()
    expect(analysisState.fingerprintSourceFile).toBeFunction()
    expect(analysisState.findDatasetForSource).toBeFunction()
    expect(analysisState.upsertDatasetIndexEntry).toBeFunction()
    expect(analysisState.latestImportStageForFingerprint).toBeFunction()
    expect(analysisState.nextStageId).toBeFunction()
    expect(analysisState.stageOutputPath).toBeFunction()
    expect(analysisState.stageInspectionPaths).toBeFunction()
    expect(analysisState.stageMetaPaths).toBeFunction()
    expect(analysisState.reportOutputPath).toBeFunction()
    expect(analysisState.visibleOutputPath).toBeFunction()
    expect(analysisState.finalOutputsPath).toBeFunction()
    expect(analysisState.resolveFinalOutputsPath).toBeFunction()
    expect(analysisState.buildFileStamp).toBeFunction()
    expect(analysisState.appendStage).toBeFunction()
    expect(analysisState.appendArtifact).toBeFunction()
    expect(analysisState.upsertFinalOutput).toBeFunction()
    expect(analysisState.publishVisibleOutput).toBeFunction()
    expect(analysisState.publishDatasetLevelOutput).toBeFunction()
    expect(analysisState.publishDeliveryOutput).toBeFunction()
    expect(analysisState.resolveArtifactInput).toBeFunction()
  })

  it("buildFileStamp 包含毫秒，保证同一秒内的独立产物路径不复用", () => {
    const first = analysisState.buildFileStamp(new Date("2026-09-02T15:00:00.123Z"))
    const second = analysisState.buildFileStamp(new Date("2026-09-02T15:00:00.456Z"))
    expect(first).not.toBe(second)
    expect(first).toMatch(/20260902-150000123$/)
    expect(second).toMatch(/20260902-150000456$/)
  })
})
