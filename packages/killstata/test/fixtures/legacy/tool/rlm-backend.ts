import fs from "fs"
import path from "path"
import z from "zod"
import RUNNER_SCRIPT from "../../../../../killstata-econometrics-engine/python/rlm/runner.py" with { type: "text" }
import { runManagedProcess } from "../../../../src/runtime/managed-process"
import { formatBackendExitError, parseLastJsonLine } from "../../../../src/util/parse-last-json-line"
import { runEngineMethodBackend } from "../../../../src/runtime/services/econometrics-engine-backend"

export type RlmPsi = "huber" | "hampel" | "tukey"
export type RlmMethod = "robust_regression"

export type RlmPayload = {
  method: RlmMethod
  dataPath: string
  outputDir: string
  dependentVar: string
  treatmentVar: string
  covariates?: string[]
  psi?: RlmPsi
  covariance?: "robust"
}

export type RlmCoefficient = {
  term: string
  estimate: number | null
  stdError: number | null
  statistic: number | null
  pValue: number | null
  confLow: number | null
  confHigh: number | null
}

export type RlmBackendResult = {
  success: boolean
  method?: RlmMethod
  backend?: "statsmodels"
  statsmodelsVersion?: string
  rowsInput?: number
  rowsUsed?: number
  droppedRows?: number
  psi?: string
  covariance?: string
  scale?: number | null
  meanOutcome?: number
  coefficients?: RlmCoefficient[]
  primary?: RlmCoefficient | null
  downWeightedCount?: number
  downWeightedPct?: number
  resultPath?: string
  coefficientsPath?: string
  warnings?: string[]
  message?: string
}

const CoefficientSchema = z
  .object({
    term: z.string().min(1),
    estimate: z.number().finite(),
    stdError: z.number().finite().nonnegative(),
    statistic: z.number().finite().nullable(),
    pValue: z.number().finite().min(0).max(1),
    confLow: z.number().finite().nullable(),
    confHigh: z.number().finite().nullable(),
  })
  .strict()

const SuccessResultSchema = z
  .object({
    success: z.literal(true),
    method: z.literal("robust_regression"),
    backend: z.literal("statsmodels"),
    statsmodelsVersion: z.string().min(1),
    rowsInput: z.number().int().nonnegative(),
    rowsUsed: z.number().int().positive(),
    droppedRows: z.number().int().nonnegative(),
    // RLM 始终使用 HC1（强制），不支持 nonrobust
    covariance: z.literal("HC1"),
    psi: z.enum(["huber", "hampel", "tukey"]),
    // scale 是 RLM 的残差尺度估计（MAD-based），恒为正
    scale: z.number().finite().positive(),
    meanOutcome: z.number().finite(),
    logLikelihood: z.null(),
    pseudoRSquared: z.null(),
    coefficients: z.array(CoefficientSchema).min(2),
    primary: CoefficientSchema,
    downWeightedCount: z.number().int().nonnegative(),
    downWeightedPct: z.number().finite().min(0).max(100),
    resultPath: z.string().min(1),
    coefficientsPath: z.string().min(1),
    warnings: z.array(z.string()),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.rowsUsed > value.rowsInput || value.droppedRows !== value.rowsInput - value.rowsUsed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "样本数量关系不一致" })
    }
  })

const FailureResultSchema = z
  .object({
    success: z.literal(false),
    message: z.string().min(1),
  })
  .passthrough()

export function validateRlmBackendResult(input: unknown): RlmBackendResult {
  const parsed = SuccessResultSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`稳健回归结果结构不完整：${parsed.error.issues[0]?.message ?? "未知结构错误"}`)
  }
  return parsed.data
}

export async function runRlmBackend(input: {
  pythonCommand: string
  cwd: string
  payload: RlmPayload
  sessionID?: string
  abort?: AbortSignal
  timeoutMs?: number
}) {
  fs.mkdirSync(input.payload.outputDir, { recursive: true })
  if (input.sessionID) {
    return await runEngineMethodBackend({
      sessionID: input.sessionID,
      pythonCommand: input.pythonCommand,
      cwd: input.cwd,
      methodID: input.payload.method,
      payload: input.payload as unknown as Record<string, unknown>,
      abort: input.abort,
    }) as RlmBackendResult
  }
  const runnerPath = path.join(
    input.payload.outputDir,
    `.killstata_rlm_runner_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`,
  )
  fs.writeFileSync(runnerPath, RUNNER_SCRIPT, "utf-8")
  try {
    const execution = await runManagedProcess({
      command: input.pythonCommand,
      allowedCommands: [input.pythonCommand],
      args: [runnerPath],
      cwd: input.cwd,
      allowedCwdRoot: input.cwd,
      stdin: JSON.stringify(input.payload),
      env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      abort: input.abort,
      timeoutMs: input.timeoutMs ?? 5 * 60 * 1_000,
      maxOutputBytes: 8 * 1024 * 1024,
    })
    if (execution.code !== 0) {
      throw new Error(formatBackendExitError("稳健回归", execution))
    }

    const rawResult = parseLastJsonLine(execution.stdout, "稳健回归")
    const failure = FailureResultSchema.safeParse(rawResult)
    if (failure.success) {
      throw new Error(failure.data.message || "稳健回归分析失败")
    }
    const result = validateRlmBackendResult(rawResult)
    if (result.method !== input.payload.method) {
      throw new Error("稳健回归返回的计量方法与请求不一致")
    }
    const expectedResultPath = path.resolve(input.payload.outputDir, "results.json")
    const expectedCoefficientsPath = path.resolve(input.payload.outputDir, "coefficients.csv")
    if (
      path.resolve(result.resultPath!) !== expectedResultPath ||
      path.resolve(result.coefficientsPath!) !== expectedCoefficientsPath
    ) {
      throw new Error("稳健回归返回了不可信的结果路径")
    }
    if (!fs.existsSync(expectedResultPath) || !fs.existsSync(expectedCoefficientsPath)) {
      throw new Error("稳健回归声明的结果文件不存在")
    }
    return result
  } finally {
    fs.rmSync(runnerPath, { force: true })
  }
}
// @ts-nocheck
