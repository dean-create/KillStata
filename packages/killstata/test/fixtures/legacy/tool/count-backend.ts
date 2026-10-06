import fs from "fs"
import path from "path"
import z from "zod"
import RUNNER_SCRIPT from "../../../../../killstata-econometrics-engine/python/count/runner.py" with { type: "text" }
import { runManagedProcess } from "../../../../src/runtime/managed-process"
import { formatBackendExitError, parseLastJsonLine } from "../../../../src/util/parse-last-json-line"
import { runEngineMethodBackend } from "../../../../src/runtime/services/econometrics-engine-backend"

export type CountMethod = "poisson_regression" | "negbin_regression"

export type CountPayload = {
  method: CountMethod
  dataPath: string
  outputDir: string
  dependentVar: string
  treatmentVar: string
  covariates?: string[]
  covariance?: "nonrobust" | "robust"
}

export type CountCoefficient = {
  term: string
  estimate: number | null
  stdError: number | null
  statistic: number | null
  pValue: number | null
  confLow: number | null
  confHigh: number | null
}

export type CountIncidenceRateRatio = {
  term: string
  irr: number | null
  confLow: number | null
  confHigh: number | null
  pValue: number | null
}

export type CountMarginalEffect = {
  term: string
  estimate: number | null
  stdError: number | null
  pValue: number | null
}

export type CountBackendResult = {
  success: boolean
  method?: CountMethod
  backend?: "statsmodels"
  statsmodelsVersion?: string
  rowsInput?: number
  rowsUsed?: number
  droppedRows?: number
  covariance?: string
  isPureCount?: boolean
  meanOutcome?: number
  logLikelihood?: number | null
  pseudoRSquared?: number | null
  dispersion?: number | null
  alpha?: number | null
  coefficients?: CountCoefficient[]
  incidenceRateRatios?: CountIncidenceRateRatio[]
  marginalEffects?: CountMarginalEffect[]
  primary?: CountCoefficient | null
  primaryIrr?: CountIncidenceRateRatio | null
  primaryMarginalEffect?: CountMarginalEffect | null
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

const IncidenceRateRatioSchema = z
  .object({
    term: z.string().min(1),
    // IRR = exp(系数)，恒为正
    irr: z.number().finite().positive(),
    confLow: z.number().finite().positive(),
    confHigh: z.number().finite().positive(),
    pValue: z.number().finite().min(0).max(1),
  })
  .strict()

const MarginalEffectSchema = z
  .object({
    term: z.string().min(1),
    estimate: z.number().finite(),
    stdError: z.number().finite().nonnegative(),
    pValue: z.number().finite().min(0).max(1),
  })
  .strict()

const SuccessResultSchema = z
  .object({
    success: z.literal(true),
    method: z.enum(["poisson_regression", "negbin_regression"]),
    backend: z.literal("statsmodels"),
    statsmodelsVersion: z.string().min(1),
    rowsInput: z.number().int().nonnegative(),
    rowsUsed: z.number().int().positive(),
    droppedRows: z.number().int().nonnegative(),
    covariance: z.enum(["nonrobust", "HC1"]),
    isPureCount: z.boolean(),
    // 计数均值恒为正（结果非负且非全零已在后端拦截）
    meanOutcome: z.number().finite().positive(),
    logLikelihood: z.number().finite().nullable(),
    pseudoRSquared: z.number().finite().nullable(),
    // Pearson 离散度恒为正；负二项的 df>0 时也应有值，允许 null 兜底
    dispersion: z.number().finite().positive().nullable(),
    // alpha 只在负二项出现，Poisson 为 null
    alpha: z.number().finite().nonnegative().nullable(),
    coefficients: z.array(CoefficientSchema).min(2),
    incidenceRateRatios: z.array(IncidenceRateRatioSchema).min(2),
    marginalEffects: z.array(MarginalEffectSchema).min(1),
    primary: CoefficientSchema,
    primaryIrr: IncidenceRateRatioSchema,
    primaryMarginalEffect: MarginalEffectSchema,
    resultPath: z.string().min(1),
    coefficientsPath: z.string().min(1),
    warnings: z.array(z.string()),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.rowsUsed > value.rowsInput || value.droppedRows !== value.rowsInput - value.rowsUsed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "样本数量关系不一致" })
    }
    // 负二项必须报告 alpha；Poisson 不应有 alpha
    if (value.method === "negbin_regression" && value.alpha === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "负二项缺少过度离散参数 alpha" })
    }
    if (value.method === "poisson_regression" && value.alpha !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Poisson 不应返回 alpha" })
    }
  })

const FailureResultSchema = z
  .object({
    success: z.literal(false),
    message: z.string().min(1),
  })
  .passthrough()

export function validateCountBackendResult(input: unknown): CountBackendResult {
  const parsed = SuccessResultSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`计数模型结果结构不完整：${parsed.error.issues[0]?.message ?? "未知结构错误"}`)
  }
  return parsed.data
}

export async function runCountBackend(input: {
  pythonCommand: string
  cwd: string
  payload: CountPayload
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
    }) as CountBackendResult
  }
  const runnerPath = path.join(
    input.payload.outputDir,
    `.killstata_count_runner_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`,
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
      throw new Error(formatBackendExitError("计数模型", execution))
    }

    const rawResult = parseLastJsonLine(execution.stdout, "计数模型")
    const failure = FailureResultSchema.safeParse(rawResult)
    if (failure.success) {
      throw new Error(failure.data.message || "计数模型分析失败")
    }
    const result = validateCountBackendResult(rawResult)
    if (result.method !== input.payload.method) {
      throw new Error("计数模型返回的计量方法与请求不一致")
    }
    const expectedResultPath = path.resolve(input.payload.outputDir, "results.json")
    const expectedCoefficientsPath = path.resolve(input.payload.outputDir, "coefficients.csv")
    if (
      path.resolve(result.resultPath!) !== expectedResultPath ||
      path.resolve(result.coefficientsPath!) !== expectedCoefficientsPath
    ) {
      throw new Error("计数模型返回了不可信的结果路径")
    }
    if (!fs.existsSync(expectedResultPath) || !fs.existsSync(expectedCoefficientsPath)) {
      throw new Error("计数模型声明的结果文件不存在")
    }
    return result
  } finally {
    fs.rmSync(runnerPath, { force: true })
  }
}
// @ts-nocheck
