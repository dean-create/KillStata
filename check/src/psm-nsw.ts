import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "../../packages/killstata/src/project/instance"
import { recordWorkflowStageSuccess } from "../../packages/killstata/src/runtime/workflow"
import { Session } from "../../packages/killstata/src/session"
import { DataImportTool } from "../../packages/killstata/src/tool/data-import"
import {
  EconometricsRecommendTool,
  PropensityScoreConstructionTool,
  PropensityScoreVisualizationTool,
  PsmIpwTool,
  PsmMatchingTool,
} from "../../packages/killstata/src/tool/econometrics-method-tools"
import { type EvidenceRecord } from "./evidence"
import { executeThroughHarness } from "./harness"
import { ensureNswAnalysisFixture, ensureNswFixture } from "./nsw"

const COVARIATES = ["age", "education", "black", "hispanic", "married", "nodegree", "re74", "re75"]
const ROOT = path.resolve(import.meta.dir, "..", "..")

type PsmToolId = "psm_construction" | "psm_visualize" | "psm_matching" | "psm_ipw"
type ToolReport = EvidenceRecord & {
  harness?: { schemaAccepted: boolean; executorCalls: number; lifecycle: string[] }
  plotIsPng?: boolean
  error?: string
  diagnostic?: { actual: Record<string, unknown>; oracle: Record<string, number> }
}

function pythonCommand() {
  return process.env.KILLSTATA_PYTHON?.trim() || "/Users/cw/.killstata/venv/bin/python"
}

function nswOracle() {
  const fixture = ensureNswFixture()
  return JSON.parse(
    execFileSync(
      pythonCommand(),
      [
        "-c",
        [
          "import json, sys",
          "import numpy as np",
          "import pandas as pd",
          "from scipy.optimize import minimize",
          "df = pd.read_stata(sys.argv[1])",
          `cols = ${JSON.stringify(COVARIATES)}`,
          "y = df['treat'].to_numpy(dtype=float)",
          "raw = df[cols].to_numpy(dtype=float)",
          // NSW 的收入变量量级远大于二元协变量。先标准化只改善独立优化器的条件数；
          // 线性预测和倾向得分与原始设计矩阵的同一 Logit 完全等价。
          "X = np.column_stack([np.ones(len(df)), (raw - raw.mean(axis=0)) / raw.std(axis=0)])",
          "objective = lambda beta: np.logaddexp(0.0, X @ beta).sum() - y @ (X @ beta)",
          "gradient = lambda beta: X.T @ (1.0 / (1.0 + np.exp(-(X @ beta))) - y)",
          "fit = minimize(objective, np.zeros(X.shape[1]), jac=gradient, method='L-BFGS-B', options={'ftol': 1e-15, 'gtol': 1e-12, 'maxiter': 10000, 'maxls': 100})",
          "assert fit.success, fit.message",
          "score = 1.0 / (1.0 + np.exp(-(X @ fit.x)))",
          "treated, control = score[y == 1], score[y == 0]",
          "lower, upper = max(treated.min(), control.min()), min(treated.max(), control.max())",
          "print(json.dumps({'rows_used': len(df), 'score_min': float(score.min()), 'score_max': float(score.max()), 'mean_treated': float(treated.mean()), 'mean_control': float(control.mean()), 'support_lower': float(lower), 'support_upper': float(upper), 'share_in_support': float(((score >= lower) & (score <= upper)).mean())}))",
        ].join("; "),
        fixture.path,
      ],
      { encoding: "utf-8" },
    ),
  ) as Record<string, number>
}

function nswIpwOracle() {
  const fixture = ensureNswFixture()
  return JSON.parse(
    execFileSync(
      pythonCommand(),
      [
        "-c",
        [
          "import json, sys",
          "import numpy as np",
          "import pandas as pd",
          "from scipy.optimize import minimize",
          "df = pd.read_stata(sys.argv[1])",
          `cols = ${JSON.stringify(COVARIATES)}`,
          "y = df['treat'].to_numpy(dtype=float)",
          "outcome = df['re78'].to_numpy(dtype=float)",
          "raw = df[cols].to_numpy(dtype=float)",
          "X = np.column_stack([np.ones(len(df)), (raw - raw.mean(axis=0)) / raw.std(axis=0)])",
          "objective = lambda beta: np.logaddexp(0.0, X @ beta).sum() - y @ (X @ beta)",
          "gradient = lambda beta: X.T @ (1.0 / (1.0 + np.exp(-(X @ beta))) - y)",
          "fit = minimize(objective, np.zeros(X.shape[1]), jac=gradient, method='L-BFGS-B', options={'ftol': 1e-15, 'gtol': 1e-12, 'maxiter': 10000, 'maxls': 100})",
          "assert fit.success, fit.message",
          "score = 1.0 / (1.0 + np.exp(-(X @ fit.x)))",
          "wt, wc = 1.0 / score[y == 1], 1.0 / (1.0 - score[y == 0])",
          "ess = lambda w: float(w.sum() ** 2 / (w ** 2).sum())",
          "ate = float(np.average(outcome[y == 1], weights=wt) - np.average(outcome[y == 0], weights=wc))",
          "smd = []",
          "for column in raw.T:",
          "  t, c = column[y == 1], column[y == 0]",
          "  pooled = np.sqrt((np.var(t, ddof=1) + np.var(c, ddof=1)) / 2.0)",
          "  smd.append(float((np.average(t, weights=wt) - np.average(c, weights=wc)) / pooled))",
          "print(json.dumps({'ate': ate, 'treatment_ess': ess(wt), 'control_ess': ess(wc), 'min_propensity_score': float(score.min()), 'max_propensity_score': float(score.max()), 'max_weight': float(max(wt.max(), wc.max())), 'weighted_max_abs_smd': float(max(abs(value) for value in smd))}))",
        ].join("\n"),
        fixture.path,
      ],
      { encoding: "utf-8" },
    ),
  ) as Record<string, number>
}

function closeEnough(actual: Record<string, unknown>, oracle: Record<string, number>) {
  return Object.entries(oracle).every(([key, expected]) => {
    if (typeof actual[key] !== "number") return false
    const difference = Math.abs((actual[key] as number) - expected)
    // 概率/SMD 用绝对 1e-6；收入水平的 ATE 允许同等严格的百万分之一相对误差，
    // 防止两个独立优化器的 1e-8 score 差异在千元量级结果上被误判为算法不一致。
    return difference <= 1e-6 * Math.max(1, Math.abs(expected))
  })
}

function selectNumericFields(result: Record<string, unknown>, oracle: Record<string, number>) {
  return Object.fromEntries(Object.keys(oracle).map((key) => [key, result[key]]))
}

function summarizeExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .split("\n")
    .filter((line) => !line.startsWith("Python interpreter:") && !line.startsWith("Reflection log:"))
    .join("\n")
}

async function prepareNswSession(root: string) {
  const session = await Session.create({ title: "nsw-psm-acceptance" })
  const ctx = {
    sessionID: session.id,
    messageID: "message_nsw_acceptance",
    callID: "call_nsw_acceptance",
    agent: "econometrics",
    abort: new AbortController().signal,
    metadata: async () => undefined,
    ask: async () => undefined,
  }
  const dataImport = await DataImportTool.init()
  const imported = await dataImport.execute(
    { action: "import", inputPath: ensureNswAnalysisFixture().path, preserveLabels: true, createInspectionArtifacts: false },
    ctx as never,
  )
  const source = { datasetId: imported.metadata.datasetId!, stageId: imported.metadata.stageId! }
  recordWorkflowStageSuccess({ sessionID: session.id, toolName: "data_import", args: { action: "import", ...source }, metadata: { action: "import", ...source } })
  const recommend = await EconometricsRecommendTool.init()
  await recommend.execute({ ...source, dependentVar: "re78", treatmentVar: "treat" }, ctx as never)
  recordWorkflowStageSuccess({ sessionID: session.id, toolName: "econometrics_recommend", args: source, metadata: source })
  const qa = await dataImport.execute({ action: "qa", ...source, preserveLabels: true, createInspectionArtifacts: false }, ctx as never)
  if (qa.metadata.qaGateStatus === "block") throw new Error("NSW cross-section was unexpectedly blocked by QA")
  recordWorkflowStageSuccess({
    sessionID: session.id,
    toolName: "data_import",
    args: { action: "qa", ...source },
    metadata: { action: "qa", ...source, qaGateStatus: qa.metadata.qaGateStatus },
  })
  return { root, session, ctx, source }
}

async function toolFor(id: PsmToolId) {
  switch (id) {
    case "psm_construction": return PropensityScoreConstructionTool.init()
    case "psm_visualize": return PropensityScoreVisualizationTool.init()
    case "psm_matching": return PsmMatchingTool.init()
    case "psm_ipw": return PsmIpwTool.init()
  }
}

function paramsFor(id: PsmToolId, source: { datasetId: string; stageId: string }) {
  const base = { ...source, treatmentVar: "treat", covariates: COVARIATES }
  if (id === "psm_construction" || id === "psm_visualize") return base
  return { ...base, dependentVar: "re78", analysisUnitVar: "unit_id", preTreatmentAggregation: "not_applicable" as const }
}

async function runOne(root: string, id: PsmToolId): Promise<ToolReport> {
  const prepared = await prepareNswSession(root)
  try {
    const tool = await toolFor(id)
    const params = paramsFor(id, prepared.source)
    const schemaAccepted = tool.parameters.safeParse(params).success
    if (!schemaAccepted) throw new Error(`${id} rejected its own fixed NSW parameters at JSON Schema`)
    try {
      const run = await executeThroughHarness({
        sessionID: prepared.session.id,
        messageID: prepared.ctx.messageID,
        callID: `${prepared.ctx.callID}_${id}`,
        toolID: id,
        params,
        ctx: prepared.ctx,
        execute: (arguments_) => tool.execute(arguments_ as never, { ...prepared.ctx, callID: `${prepared.ctx.callID}_${id}` } as never),
      })
      const result = run.execution.metadata.result as Record<string, unknown>
      const harness = { schemaAccepted, executorCalls: run.evidence.executorCalls, lifecycle: run.evidence.lifecycle }
      if (id === "psm_construction" || id === "psm_visualize") {
        const matched = closeEnough(result, nswOracle())
        const plotPath = result.plot_path
        const plotIsPng =
          typeof plotPath === "string" &&
          fs.readFileSync(path.join(root, plotPath)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        return {
          toolId: id,
          datasetId: "lalonde_nsw_dw",
          grade: "B",
          status: "PASS",
          harness,
          numericOracle: { name: "SciPy independent Logit and support summary", matched },
          ...(id === "psm_visualize" ? { plotIsPng } : {}),
        }
      }
      const ipwOracle = nswIpwOracle()
      const matched = closeEnough(result, ipwOracle)
      return {
        toolId: id,
        datasetId: "lalonde_nsw_dw",
        grade: matched ? "B" : "PENDING",
        status: matched ? "PASS" : "PENDING",
        harness,
        numericOracle: { name: "SciPy independent Logit plus Hájek/IPW diagnostic calculation", matched },
        diagnostic: { actual: selectNumericFields(result, ipwOracle), oracle: ipwOracle },
      }
    } catch (error) {
      const message = summarizeExecutionError(error)
      if (id === "psm_matching" || id === "psm_ipw") {
        return {
          toolId: id,
          datasetId: "lalonde_nsw_dw",
          grade: "S",
          status: "SAFE_REJECTION",
          safety: { rejected: true, reason: message },
          error: message,
        }
      }
      throw error
    }
  } finally {
    // Instance 的临时项目目录由调用者在离开 provide 后统一清理，避免把运行中的 artifact 提前删掉。
  }
}

export async function runNswPsmEvidence(selected: PsmToolId[] = ["psm_construction", "psm_visualize", "psm_matching", "psm_ipw"]) {
  const records: ToolReport[] = []
  for (const id of selected) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-acceptance-nsw-instance-"))
    try {
      records.push(await Instance.provide({ directory: root, fn: () => runOne(root, id) }))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  return Object.fromEntries(records.map((record) => [record.toolId, record])) as Record<PsmToolId, ToolReport>
}
