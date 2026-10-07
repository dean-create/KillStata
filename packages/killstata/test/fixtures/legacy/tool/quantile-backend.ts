import fs from "fs"
import path from "path"
import z from "zod"
import RUNNER_SCRIPT from "../../../../../killstata-econometrics-engine/python/quantile/runner.py" with { type: "text" }
import { runManagedProcess } from "../../../../src/runtime/managed-process"
import { formatBackendExitError, parseLastJsonLine } from "../../../../src/util/parse-last-json-line"
import { runEngineMethodBackend } from "../../../../src/runtime/services/econometrics-engine-backend"

export type QuantileMethod = "quantile_regression"

export type QuantilePayload = {
  method: QuantileMethod
  dataPath: string
  outputDir: string
  dependentVar: string
  treatmentVar: string
  covariates?: string[]
  quantiles?: number[]
  covariance?: "robust" | "iid"
}

export type QuantileCoefficient = {
  term: string
  estimate: number | null
  stdError: number | null
  statistic: number | null
  pValue: number | null
  confLow: number | null
  confHigh: number | null
}

export type QuantileFit = {
  tau: number
  pseudoRSquared: number | null
  coefficients: QuantileCoefficient[]
  primary: QuantileCoefficient | null
}

export type QuantilePathPoint = {
  tau: number
  estimate: number | null
  stdError: number | null
  pValue: number | null
  confLow: number | null
  confHigh: number | null
}

export type QuantileBackendResult = {
  success: boolean
  method?: QuantileMethod
  backend?: "statsmodels"
  statsmodelsVersion?: string
  rowsInput?: number
  rowsUsed?: number
  droppedRows?: number
  covariance?: string
  quantiles?: number[]
  outcomeMean?: number
  fits?: QuantileFit[]
  primaryTau?: number
  primary?: QuantileCoefficient | null
  treatmentPath?: QuantilePathPoint[]
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
    confLow: z.number().finite(),
    confHigh: z.number().finite(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.confLow > value.estimate || value.estimate > value.confHigh) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "点估计不在置信区间内" })
    }
  })

const Tau = z.number().finite().gt(0).lt(1)

const FitSchema = z
  .object({
    tau: Tau,
    pseudoRSquared: z.number().finite().nullable(),
    coefficients: z.array(CoefficientSchema).min(2),
    primary: CoefficientSchema,
  })
  .strict()

const PathPointSchema = z
  .object({
    tau: Tau,
    estimate: z.number().finite(),
    stdError: z.number().finite().nonnegative(),
    pValue: z.number().finite().min(0).max(1),
    confLow: z.number().finite(),
    confHigh: z.number().finite(),
  })
  .strict()

const SuccessResultSchema = z
  .object({
    success: z.literal(true),
    method: z.literal("quantile_regression"),
    backend: z.literal("statsmodels"),
    statsmodelsVersion: z.string().min(1),
    rowsInput: z.number().int().nonnegative(),
    rowsUsed: z.number().int().positive(),
    droppedRows: z.number().int().nonnegative(),
    covariance: z.enum(["robust", "iid"]),
    quantiles: z.array(Tau).min(1),
    outcomeMean: z.number().finite(),
    fits: z.array(FitSchema).min(1),
    primaryTau: Tau,
    primary: CoefficientSchema,
    treatmentPath: z.array(PathPointSchema).min(1),
    resultPath: z.string().min(1),
    coefficientsPath: z.string().min(1),
    warnings: z.array(z.string()),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.rowsUsed > value.rowsInput || value.droppedRows !== value.rowsInput - value.rowsUsed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "样本数量关系不一致" })
    }
    if (value.fits.length !== value.quantiles.length || value.treatmentPath.length !== value.quantiles.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "分位点数量与拟合结果数量不一致" })
    }
    if (!value.quantiles.includes(value.primaryTau)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "主报告分位点必须在请求的分位点集合内" })
    }
  })

const FailureResultSchema = z
  .object({
    success: z.literal(false),
    message: z.string().min(1),
  })
  .passthrough()

export function validateQuantileBackendResult(input: unknown): QuantileBackendResult {
  const parsed = SuccessResultSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`分位数回归结果结构不完整：${parsed.error.issues[0]?.message ?? "未知结构错误"}`)
  }
  return parsed.data
}

export async function runQuantileBackend(input: {
  pythonCommand: string
  cwd: string
  payload: QuantilePayload
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
    }) as QuantileBackendResult
  }
  const runnerPath = path.join(
    input.payload.outputDir,
    `.killstata_quantile_runner_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`,
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
      throw new Error(formatBackendExitError("分位数回归", execution))
    }

    const rawResult = parseLastJsonLine(execution.stdout, "分位数回归")
    const failure = FailureResultSchema.safeParse(rawResult)
    if (failure.success) {
      throw new Error(failure.data.message || "分位数回归分析失败")
    }
    const result = validateQuantileBackendResult(rawResult)
    if (result.method !== input.payload.method) {
      throw new Error("分位数回归返回的计量方法与请求不一致")
    }
    const expectedResultPath = path.resolve(input.payload.outputDir, "results.json")
    const expectedCoefficientsPath = path.resolve(input.payload.outputDir, "coefficients.csv")
    if (
      path.resolve(result.resultPath!) !== expectedResultPath ||
      path.resolve(result.coefficientsPath!) !== expectedCoefficientsPath
    ) {
      throw new Error("分位数回归返回了不可信的结果路径")
    }
    if (!fs.existsSync(expectedResultPath) || !fs.existsSync(expectedCoefficientsPath)) {
      throw new Error("分位数回归声明的结果文件不存在")
    }
    return result
  } finally {
    fs.rmSync(runnerPath, { force: true })
  }
}
// @ts-nocheck
