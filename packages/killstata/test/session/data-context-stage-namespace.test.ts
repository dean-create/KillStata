import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { createDatasetManifest, appendStage } from "@/tool/analysis-state"
import { readStoredDataReadinessState } from "@/runtime/data-readiness"

/**
 * 2026-08-28 did.xlsx 真实会话：<data-readiness> 每轮都注入
 * 「读取当前数据阶段的就绪报告失败，需要重新执行数据画像」，模型据此反复重跑
 * profile/validate，却永远清不掉。
 *
 * 根因不是报告缺失——真实 manifest 的三个 stage 全都有 readiness。而是
 * data-context 把 **workflow 节点 ID**（stage_001__profile_or_schema_check）
 * 当成 **dataset stage ID** 去查 manifest，getStage 抛错落进 catch。
 *
 * 两套 ID 是不同命名空间：workflow 节点会因 kind 冲突派生 `__kind` / `_001` 后缀。
 */
describe("data-context 的 stage 命名空间", () => {
  test("workflow 节点 ID 必须先归一到数据阶段 ID 再查就绪报告", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-data-context-ns-"))
    try {
      await Instance.provide({
        directory: root,
        fn: async () => {
          const datasetId = "ns_dataset"
          const sourcePath = path.join(root, "d.csv")
          fs.writeFileSync(sourcePath, "id,y\na,1\nb,2\n", "utf-8")

          const manifest = createDatasetManifest({ datasetId, sourcePath, sourceFormat: "csv" })
          appendStage(manifest, {
            stageId: "stage_001",
            branch: "main",
            action: "preprocess_combine_columns",
            workingPath: sourcePath,
            workingFormat: "parquet",
            createdAt: new Date().toISOString(),
            metadata: {
              dataReadiness: {
                version: 1,
                generatedAt: new Date().toISOString(),
                rowCount: 2,
                columnCount: 2,
                sourceStageId: "stage_001",
                columns: [{ name: "y", type: "numeric", missingCount: 0, uniqueCount: 2, constant: false }],
                panelCandidates: [],
                exactLinearDependencies: [],
                candidateMethods: [],
                warnings: [],
              },
            },
          })

          // 基线：数据阶段 ID 本来就能读到
          const direct = readStoredDataReadinessState(datasetId, "stage_001")
          expect(direct.report).toBeDefined()
          expect(direct.stale).toBe(false)

          // 真实会话传进来的是 workflow 节点 ID（kind 冲突时派生 __kind / _001 后缀）。
          // 它们指向同一个数据阶段，必须读到同一份报告，而不是回落成"读取失败"。
          for (const nodeID of ["stage_001__profile_or_schema_check", "stage_001__baseline_estimate_001"]) {
            const state = readStoredDataReadinessState(datasetId, nodeID)
            expect(state.report, `${nodeID} 应归一到 stage_001`).toBeDefined()
            expect(state.reason ?? "", `${nodeID} 不得产生永久假警报`).not.toContain(
              "读取当前数据阶段的就绪报告失败",
            )
          }
        },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
