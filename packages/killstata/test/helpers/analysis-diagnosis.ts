import path from "node:path"
import { econometricsEngineRoot, resolveRuntimePythonCommand } from "@/killstata/runtime-config"
import { Instance } from "@/project/instance"
import { sessionEconometricsEngine } from "@/runtime/services/econometrics-engine-client"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { writeDatasetManifest } from "@/tool/analysis-state"

type DatasetManifest = Parameters<typeof writeDatasetManifest>[0]

/** Ask the Python Registry for the canonical content fingerprint used by upload diagnostics. */
export async function dataFingerprintForTest(input: {
  sessionID: string
  dataPath: string
  dependentVar: string
  treatmentVar: string
  pythonCommand?: string
}) {
  const engineRoot = econometricsEngineRoot()
  const engine = sessionEconometricsEngine(input.sessionID, {
    command: input.pythonCommand ?? await resolveRuntimePythonCommand(),
    cwd: Instance.directory,
    pythonPath: path.join(engineRoot, "src"),
    methodRoot: path.join(engineRoot, "python"),
  })
  const preflight = await engine.preflight({
    method_id: "ols_regression",
    data_path: input.dataPath,
    arguments: {
      dependentVar: input.dependentVar,
      treatmentVar: input.treatmentVar,
      covariates: [],
      covariance: "HC1",
    },
  })
  return preflight.data_fingerprint
}

/** Create the same Python-owned data fingerprint used by upload diagnostics and bind it to a fixture stage/task. */
export async function recordAnalysisStageDiagnosisForTest(input: {
  sessionID: string
  taskId?: string
  datasetId: string
  stageId: string
  dataPath: string
  dependentVar: string
  treatmentVar: string
  pythonCommand?: string
  manifest: DatasetManifest
}) {
  const fingerprint = await dataFingerprintForTest(input)
  const stage = input.manifest.stages.find((item) => item.stageId === input.stageId)
  if (!stage || input.manifest.datasetId !== input.datasetId) {
    throw new Error(`analysis diagnosis fixture does not match ${input.datasetId}/${input.stageId}`)
  }
  stage.metadata = {
    ...(stage.metadata ?? {}),
    dataDiagnosis: { stage_id: input.stageId, data_fingerprint: fingerprint },
  }
  writeDatasetManifest(input.manifest)

  if (!input.taskId) return fingerprint
  const task = RuntimeTaskLedger.listTasks(input.sessionID).tasks.find((item) => item.taskId === input.taskId)
  if (!task?.analysisRequest) throw new Error(`analysis task ${input.taskId} has no registered request`)
  RuntimeTaskLedger.transitionAnalysis({
    sessionID: input.sessionID,
    taskId: task.taskId,
    event: { type: "diagnosis_started", requestId: task.analysisRequest.requestId },
  })
  RuntimeTaskLedger.transitionAnalysis({
    sessionID: input.sessionID,
    taskId: task.taskId,
    event: {
      type: "diagnosis_completed",
      requestId: task.analysisRequest.requestId,
      datasetId: input.datasetId,
      stageId: input.stageId,
      stageFingerprint: fingerprint,
    },
  })
  return fingerprint
}
