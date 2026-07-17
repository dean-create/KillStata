import path from "path"
import { recordWorkflowStageSuccess } from "@/runtime/workflow"
import { appendStage, createDatasetManifest } from "@/tool/analysis-state"

export function registerCanonicalDataset(input: {
  sessionID: string
  sourcePath: string
  datasetId?: string
  stageId?: string
}) {
  const datasetId = input.datasetId ?? `dataset_${path.basename(input.sourcePath).replace(/[^a-z0-9]+/gi, "_")}`
  const stageId = input.stageId ?? "stage_000"
  const manifest = createDatasetManifest({
    datasetId,
    sourcePath: input.sourcePath,
    sourceFormat: path.extname(input.sourcePath).replace(/^\./, "").toLowerCase() as "csv",
  })
  appendStage(manifest, {
    stageId,
    branch: "main",
    action: "import",
    workingPath: input.sourcePath,
    workingFormat: "parquet",
    createdAt: new Date().toISOString(),
  })

  recordWorkflowStageSuccess({
    sessionID: input.sessionID,
    toolName: "data_import",
    args: { action: "import", datasetId, stageId },
    metadata: { action: "import", datasetId, stageId },
  })
  recordWorkflowStageSuccess({
    sessionID: input.sessionID,
    toolName: "econometrics_recommend",
    args: { datasetId, stageId },
    metadata: { datasetId, stageId },
  })
  recordWorkflowStageSuccess({
    sessionID: input.sessionID,
    toolName: "data_import",
    args: { action: "qa", datasetId, stageId },
    metadata: { action: "qa", datasetId, stageId, qaGateStatus: "pass" },
  })
  return { datasetId, stageId }
}
