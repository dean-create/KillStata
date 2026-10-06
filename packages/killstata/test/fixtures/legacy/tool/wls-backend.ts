import fs from "fs"
import path from "path"
import z from "zod"
import RUNNER_SCRIPT from "../../../../../killstata-econometrics-engine/python/wls/runner.py" with { type: "text" }
import { runManagedProcess } from "../../../../src/runtime/managed-process"
import { formatBackendExitError, parseLastJsonLine } from "../../../../src/util/parse-last-json-line"
import { runEngineMethodBackend } from "../../../../src/runtime/services/econometrics-engine-backend"

export type WlsMethod = "wls_regression"

export type WlsPayload = {
  method: WlsMethod
  dataPath: string
  outputDir: string
  dependentVar: string
  treatmentVar: string
  covariates?: string[]
  weightsVar: string
  covariance?: "nonrobust" | "robust"
}

export type WlsCoefficient = {
  term: string
  estimate: number | null
  stdError: number | null
  statistic: number | null
  pValue: number | null
  confLow: number | null
  confHigh: number | null
}

export type WlsWeightSummary = {
  minWeight: number | null
  maxWeight: number | null
  medianWeight: number | null
  zeroCount: number
}

export type WlsBackendResult = {
  success: boolean
  method?: WlsMethod
  backend?: "statsmodels"
  statsmodelsVersion?: string
  rowsInput?: number
  rowsUsed?: number
  droppedRows?: number
  covariance?: string
  weightSummary?: WlsWeightSummary
  rsquared?: number | null
  adjRsquared?: number | null
  coefficients?: WlsCoefficient[]
  primary?: WlsCoefficient | null
  resultPath?: string
  coefficientsPath?: string
  warnings?: string[]
  message?: string
}

const CoefficientSchema = z.object({
  term: z.string().min(1),
  estimate: z.number().finite(),
  stdError: z.number().finite().nonnegative(),
  statistic: z.number().finite().nullable(),
  pValue: z.number().finite().min(0).max(1),
  confLow: z.number().finite(),
  confHigh: z.number().finite(),
}).strict()

const WeightSummarySchema = z.object({
  minWeight: z.number().finite().nonnegative(),
  maxWeight: z.number().finite().positive(),
  medianWeight: z.number().finite().positive(),
  zeroCount: z.number().int().nonnegative(),
}).strict()

const SuccessResultSchema = z.object({
  success: z.literal(true),
  method: z.literal("wls_regression"),
  backend: z.literal("statsmodels"),
  statsmodelsVersion: z.string().min(1),
  rowsInput: z.number().int().nonnegative(),
  rowsUsed: z.number().int().positive(),
  droppedRows: z.number().int().nonnegative(),
  covariance: z.enum(["nonrobust", "HC1"]),
  weightSummary: WeightSummarySchema,
  rsquared: z.number().finite().nullable(),
  adjRsquared: z.number().finite().nullable(),
  coefficients: z.array(CoefficientSchema).min(2),
  primary: CoefficientSchema,
  resultPath: z.string().min(1),
  coefficientsPath: z.string().min(1),
  warnings: z.array(z.string()),
}).strict()

const FailureResultSchema = z.object({
  success: z.literal(false),
  message: z.string().min(1),
}).passthrough()

export function validateWlsBackendResult(input: unknown): WlsBackendResult {
  const parsed = SuccessResultSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`加权最小二乘结果结构不完整：${parsed.error.issues[0]?.message ?? "未知结构错误"}`)
  }
  return parsed.data
}

export async function runWlsBackend(input: {
  pythonCommand: string
  cwd: string
  payload: WlsPayload
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
    }) as WlsBackendResult
  }
  const runnerPath = path.join(
    input.payload.outputDir,
    `.killstata_wls_runner_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`,
  )
  fs.writeFileSync(runnerPath, RUNNER_SCRIPT, "utf-8")
  try {
    const execution = await runManagedProcess({
      command: input.pythonCommand,
      allowedCommands: [input.pythonCommand],
      args: [runnerPath], cwd: input.cwd, allowedCwdRoot: input.cwd,
      stdin: JSON.stringify(input.payload),
      env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      abort: input.abort, timeoutMs: input.timeoutMs ?? 5 * 60 * 1_000, maxOutputBytes: 8 * 1024 * 1024,
    })
    if (execution.code !== 0)
      throw new Error(formatBackendExitError("加权最小二乘", execution))
    const rawResult = parseLastJsonLine(execution.stdout, "加权最小二乘")
    const failure = FailureResultSchema.safeParse(rawResult)
    if (failure.success) throw new Error(failure.data.message || "加权最小二乘分析失败")
    const result = validateWlsBackendResult(rawResult)
    if (result.method !== input.payload.method) throw new Error("加权最小二乘返回的计量方法与请求不一致")
    const ep = path.resolve(input.payload.outputDir, "results.json")
    const ec = path.resolve(input.payload.outputDir, "coefficients.csv")
    if (path.resolve(result.resultPath!) !== ep || path.resolve(result.coefficientsPath!) !== ec) {
      throw new Error("加权最小二乘返回了不可信的结果路径")
    }
    if (!fs.existsSync(ep) || !fs.existsSync(ec)) {
      throw new Error("加权最小二乘声明的结果文件不存在")
    }
    return result
  } finally {
    fs.rmSync(runnerPath, { force: true })
  }
}
// @ts-nocheck
