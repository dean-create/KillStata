import fs from "fs"
import path from "path"
import z from "zod"
import RUNNER_SCRIPT from "../../../../../killstata-econometrics-engine/python/glm/runner.py" with { type: "text" }
import { runManagedProcess } from "../../../../src/runtime/managed-process"
import { formatBackendExitError, parseLastJsonLine } from "../../../../src/util/parse-last-json-line"
import { runEngineMethodBackend } from "../../../../src/runtime/services/econometrics-engine-backend"

export type GlmMethod = "logit_regression" | "probit_regression"

export type GlmPayload = {
  method: GlmMethod
  dataPath: string
  outputDir: string
  dependentVar: string
  treatmentVar: string
  covariates?: string[]
  covariance?: "nonrobust" | "robust"
}

export type GlmCoefficient = {
  term: string
  estimate: number | null
  stdError: number | null
  statistic: number | null
  pValue: number | null
  confLow: number | null
  confHigh: number | null
}

export type GlmMarginalEffect = {
  term: string
  estimate: number | null
  stdError: number | null
  pValue: number | null
}

export type GlmBackendResult = {
  success: boolean
  method?: GlmMethod
  backend?: "statsmodels"
  statsmodelsVersion?: string
  rowsInput?: number
  rowsUsed?: number
  droppedRows?: number
  covariance?: string
  outcomeRate?: number
  logLikelihood?: number | null
  pseudoRSquared?: number | null
  coefficients?: GlmCoefficient[]
  marginalEffects?: GlmMarginalEffect[]
  primary?: GlmCoefficient | null
  primaryMarginalEffect?: GlmMarginalEffect | null
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
    method: z.enum(["logit_regression", "probit_regression"]),
    backend: z.literal("statsmodels"),
    statsmodelsVersion: z.string().min(1),
    rowsInput: z.number().int().nonnegative(),
    rowsUsed: z.number().int().positive(),
    droppedRows: z.number().int().nonnegative(),
    covariance: z.enum(["nonrobust", "HC1"]),
    outcomeRate: z.number().finite().gt(0).lt(1),
    logLikelihood: z.number().finite().nullable(),
    pseudoRSquared: z.number().finite().nullable(),
    coefficients: z.array(CoefficientSchema).min(2),
    marginalEffects: z.array(MarginalEffectSchema).min(1),
    primary: CoefficientSchema,
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
  })

const FailureResultSchema = z
  .object({
    success: z.literal(false),
    message: z.string().min(1),
  })
  .passthrough()

export function validateGlmBackendResult(input: unknown): GlmBackendResult {
  const parsed = SuccessResultSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`GLM 结果结构不完整：${parsed.error.issues[0]?.message ?? "未知结构错误"}`)
  }
  return parsed.data
}

export async function runGlmBackend(input: {
  pythonCommand: string
  cwd: string
  payload: GlmPayload
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
    }) as GlmBackendResult
  }
  const runnerPath = path.join(
    input.payload.outputDir,
    `.killstata_glm_runner_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`,
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
      throw new Error(formatBackendExitError("GLM", execution))
    }

    const rawResult = parseLastJsonLine(execution.stdout, "GLM ")
    const failure = FailureResultSchema.safeParse(rawResult)
    if (failure.success) {
      throw new Error(failure.data.message || "GLM 计量分析失败")
    }
    const result = validateGlmBackendResult(rawResult)
    if (result.method !== input.payload.method) {
      throw new Error("GLM 返回的计量方法与请求不一致")
    }
    const expectedResultPath = path.resolve(input.payload.outputDir, "results.json")
    const expectedCoefficientsPath = path.resolve(input.payload.outputDir, "coefficients.csv")
    if (
      path.resolve(result.resultPath!) !== expectedResultPath ||
      path.resolve(result.coefficientsPath!) !== expectedCoefficientsPath
    ) {
      throw new Error("GLM 返回了不可信的结果路径")
    }
    if (!fs.existsSync(expectedResultPath) || !fs.existsSync(expectedCoefficientsPath)) {
      throw new Error("GLM 声明的结果文件不存在")
    }
    return result
  } finally {
    fs.rmSync(runnerPath, { force: true })
  }
}
// @ts-nocheck
