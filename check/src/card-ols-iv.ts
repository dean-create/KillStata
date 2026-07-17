import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "../../packages/killstata/src/project/instance"
import { recordWorkflowStageSuccess } from "../../packages/killstata/src/runtime/workflow"
import { Session } from "../../packages/killstata/src/session"
import { DataImportTool } from "../../packages/killstata/src/tool/data-import"
import { EconometricsRecommendTool, Iv2slsTool, OlsRegressionTool } from "../../packages/killstata/src/tool/econometrics-method-tools"
import { compareNumericResult, type NumericResult } from "./numeric"
import { executeThroughHarness } from "./harness"

const ROOT = path.resolve(import.meta.dir, "..", "..")
const CONTROLS = ["exper", "expersq", "black", "south", "smsa"]

type CardOracle = { path: string; sha256: string; rows: number; ols: NumericResult; iv: NumericResult }
type ToolEvidence = {
  harness: { lifecycle: string[]; executorCalls: number }
  result: NumericResult
  numericOracle: { matched: boolean; failures: string[] }
}

function pythonCommand() {
  return process.env.KILLSTATA_PYTHON?.trim() || "/Users/cw/.killstata/venv/bin/python"
}

function loadCardOracle(): CardOracle {
  const script = path.join(ROOT, "check", "scripts", "card_ols_iv_oracle.py")
  const target = path.join(ROOT, "check", "data", "card1995.csv")
  return JSON.parse(execFileSync(pythonCommand(), [script, target], { encoding: "utf-8" })) as CardOracle
}

async function prepareCardSession(root: string) {
  const oracle = loadCardOracle()
  const session = await Session.create({ title: "card-ols-iv-acceptance" })
  const ctx = {
    sessionID: session.id,
    messageID: "message_card_acceptance",
    callID: "call_card_acceptance",
    agent: "econometrics",
    abort: new AbortController().signal,
    metadata: async () => undefined,
    ask: async () => undefined,
  }
  const dataImport = await DataImportTool.init()
  const imported = await dataImport.execute(
    { action: "import", inputPath: oracle.path, preserveLabels: true, createInspectionArtifacts: false },
    ctx as never,
  )
  const source = { datasetId: imported.metadata.datasetId!, stageId: imported.metadata.stageId! }
  recordWorkflowStageSuccess({ sessionID: session.id, toolName: "data_import", args: { action: "import", ...source }, metadata: { action: "import", ...source } })
  const recommend = await EconometricsRecommendTool.init()
  await recommend.execute({ ...source, dependentVar: "lwage", treatmentVar: "educ" }, ctx as never)
  recordWorkflowStageSuccess({ sessionID: session.id, toolName: "econometrics_recommend", args: source, metadata: source })
  const qa = await dataImport.execute({ action: "qa", ...source, preserveLabels: true, createInspectionArtifacts: false }, ctx as never)
  if (qa.metadata.qaGateStatus === "block") throw new Error("Card data was unexpectedly blocked by QA")
  recordWorkflowStageSuccess({ sessionID: session.id, toolName: "data_import", args: { action: "qa", ...source }, metadata: { action: "qa", ...source, qaGateStatus: qa.metadata.qaGateStatus } })
  return { root, oracle, session, ctx, source }
}

async function runOne(kind: "ols" | "iv"): Promise<{ evidence: ToolEvidence; invalidInstrumentSchemaRejected: boolean }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-card-acceptance-"))
  try {
    return await Instance.provide({
      directory: root,
      fn: async () => {
        const prepared = await prepareCardSession(root)
        const tool = kind === "ols" ? await OlsRegressionTool.init() : await Iv2slsTool.init()
        const params = kind === "ols"
          ? { ...prepared.source, dependentVar: "lwage", treatmentVar: "educ", covariates: CONTROLS, covariance: "HC1" as const }
          : {
              ...prepared.source,
              dependentVar: "lwage",
              endogenousVar: "educ",
              instrumentVar: "nearc4",
              instrumentJustification: "Card (1995) college proximity shifts schooling costs and is excluded from wages conditional on controls.",
              covariates: CONTROLS,
              covariance: "robust" as const,
            }
        const parsed = tool.parameters.safeParse(params)
        if (!parsed.success) throw new Error(`${kind} fixed Card parameters failed schema validation`)
        const run = await executeThroughHarness({
          sessionID: prepared.session.id,
          messageID: prepared.ctx.messageID,
          callID: `${prepared.ctx.callID}_${kind}`,
          toolID: kind === "ols" ? "ols_regression" : "iv_2sls",
          params,
          ctx: prepared.ctx,
          execute: (arguments_) => tool.execute(arguments_ as never, { ...prepared.ctx, callID: `${prepared.ctx.callID}_${kind}` } as never),
        })
        const result = run.execution.metadata.result as { rows_used: number; coefficient: number; std_error: number }
        const actual = { rowsUsed: result.rows_used, coefficient: result.coefficient, stdError: result.std_error }
        const expected = prepared.oracle[kind]
        const invalidInstrumentSchemaRejected =
          kind === "iv" &&
          !tool.parameters.safeParse({ ...params, instrumentVar: "educ" }).success
        return {
          evidence: {
            harness: { lifecycle: run.evidence.lifecycle, executorCalls: run.evidence.executorCalls },
            result: actual,
            numericOracle: { matched: compareNumericResult(actual, expected).length === 0, failures: compareNumericResult(actual, expected) },
          },
          invalidInstrumentSchemaRejected,
        }
      },
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

export async function runCardOlsIvEvidence() {
  const ols = await runOne("ols")
  const iv = await runOne("iv")
  return { ols: ols.evidence, iv: iv.evidence, invalidInstrumentSchemaRejected: iv.invalidInstrumentSchemaRejected }
}
