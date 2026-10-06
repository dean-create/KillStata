import fs from "fs"
import path from "path"
import z from "zod"
import RUNNER_SCRIPT from "../../../../../killstata-econometrics-engine/python/rdd/runner.py" with { type: "text" }
import { runManagedProcess } from "../../../../src/runtime/managed-process"
import { formatBackendExitError, parseLastJsonLine } from "../../../../src/util/parse-last-json-line"
import { runEngineMethodBackend } from "../../../../src/runtime/services/econometrics-engine-backend"

export type RddMethod = "rdd_sharp" | "rdd_fuzzy"

export type RddPayload = {
  method: RddMethod
  dataPath: string
  outputDir: string
  dependentVar: string
  runningVar: string
  cutoff: number
  covariates?: string[]
  fuzzyVar?: string
}

export type RddEstimate = {
  estimate: number | null
  stdError: number | null
  pValue: number | null
  confLow: number | null
  confHigh: number | null
}

export type RddBackendResult = {
  success: boolean
  method?: RddMethod
  backend?: "rdrobust"
  rdrobustVersion?: string
  rowsInput?: number
  rowsUsed?: number
  cutoff?: number
  runningVar?: string
  dependentVar?: string
  bandwidth?: { h: number | null; b: number | null }
  nEffective?: { left: number | null; right: number | null }
  conventional?: RddEstimate
  biasCorrected?: RddEstimate
  robust?: RddEstimate
  primary?: RddEstimate
  warnings?: string[]
  resultPath?: string
  coefficientsPath?: string
  message?: string
}

const EstimateSchema = z
  .object({
    estimate: z.number().finite(),
    stdError: z.number().finite().nonnegative(),
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

const SuccessResultSchema = z
  .object({
    success: z.literal(true),
    method: z.enum(["rdd_sharp", "rdd_fuzzy"]),
    backend: z.literal("rdrobust"),
    rdrobustVersion: z.string().min(1),
    rowsInput: z.number().int().nonnegative(),
    rowsUsed: z.number().int().positive(),
    cutoff: z.number().finite(),
    runningVar: z.string().min(1),
    dependentVar: z.string().min(1),
    fuzzyVar: z.string().nullable().optional(),
    bandwidth: z.object({ h: z.number().finite().positive(), b: z.number().finite().positive() }).strict(),
    nEffective: z.object({ left: z.number().int().positive(), right: z.number().int().positive() }).strict(),
    conventional: EstimateSchema,
    biasCorrected: EstimateSchema,
    robust: EstimateSchema,
    primary: EstimateSchema,
    warnings: z.array(z.string()),
    resultPath: z.string().min(1),
    coefficientsPath: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.rowsUsed > value.rowsInput) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "有效样本不能超过输入样本" })
    }
  })

const FailureResultSchema = z.object({ success: z.literal(false), message: z.string().min(1) }).passthrough()

export function validateRddBackendResult(input: unknown): RddBackendResult {
  const parsed = SuccessResultSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`断点回归结果结构不完整：${parsed.error.issues[0]?.message ?? "未知结构错误"}`)
  }
  return parsed.data
}

export async function runRddBackend(input: {
  pythonCommand: string
  cwd: string
  payload: RddPayload
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
    }) as RddBackendResult
  }
  const runnerPath = path.join(
    input.payload.outputDir,
    `.killstata_rdd_runner_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`,
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
      throw new Error(formatBackendExitError("断点回归", execution))
    }
    const rawResult = parseLastJsonLine(execution.stdout, "断点回归")
    const failure = FailureResultSchema.safeParse(rawResult)
    if (failure.success) {
      throw new Error(failure.data.message || "断点回归分析失败")
    }
    const result = validateRddBackendResult(rawResult)
    if (result.method !== input.payload.method) {
      throw new Error("断点回归返回的计量方法与请求不一致")
    }
    const expectedResultPath = path.resolve(input.payload.outputDir, "results.json")
    const expectedCoefficientsPath = path.resolve(input.payload.outputDir, "coefficients.csv")
    if (
      path.resolve(result.resultPath!) !== expectedResultPath ||
      path.resolve(result.coefficientsPath!) !== expectedCoefficientsPath
    ) {
      throw new Error("断点回归返回了不可信的结果路径")
    }
    if (!fs.existsSync(expectedResultPath) || !fs.existsSync(expectedCoefficientsPath)) {
      throw new Error("断点回归声明的结果文件不存在")
    }
    return result
  } finally {
    fs.rmSync(runnerPath, { force: true })
  }
}
// @ts-nocheck
