import fs from "fs"
import path from "path"
import z from "zod"
import RUNNER_SCRIPT from "../../python/pyfixest/runner.py" with { type: "text" }
import { runManagedProcess } from "@/runtime/managed-process"

export type PyfixestPayload = {
  method: "hdfe_regression" | "did_static" | "did2s" | "did_event_study_saturated"
  dataPath: string
  outputDir: string
  dependentVar: string
  treatmentVar?: string
  groupVar?: string
  postVar?: string
  relativeTimeVar?: string
  cohortVar?: string
  entityVar?: string
  timeVar?: string
  clusterVar?: string
  covariates?: string[]
  fixedEffects?: string[]
  clusterVars?: string[]
  covariance?: "HC1" | "CRV1" | "CRV3"
  referencePeriod?: number
  aggregateAtt?: false
}

export type PyfixestCoefficient = {
  term: string
  estimate: number | null
  stdError: number | null
  statistic: number | null
  pValue: number | null
  confLow: number | null
  confHigh: number | null
}

export type PyfixestBackendResult = {
  success: boolean
  method?: PyfixestPayload["method"]
  backend?: "pyfixest"
  pyfixestVersion?: string
  rowsInput?: number
  rowsUsed?: number
  droppedRows?: number
  coefficients?: PyfixestCoefficient[]
  primary?: PyfixestCoefficient | null
  rSquared?: number | null
  rSquaredWithin?: number | null
  covariance?: string | null
  clusterVars?: string[]
  clusterCounts?: Record<string, number>
  fixedEffects?: string[]
  referencePeriod?: number
  coefficientsPath?: string
  resultPath?: string
  errorCode?: string
  message?: string
  warnings?: string[]
}

const CoefficientSchema = z.object({
  term: z.string().min(1),
  estimate: z.number().finite(),
  stdError: z.number().finite().nonnegative(),
  statistic: z.number().finite().nullable(),
  pValue: z.number().finite().min(0).max(1),
  confLow: z.number().finite(),
  confHigh: z.number().finite(),
}).strict().superRefine((value, ctx) => {
  if (value.confLow > value.estimate || value.estimate > value.confHigh) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "点估计不在置信区间内" })
  }
})

const SuccessResultSchema = z.object({
  success: z.literal(true),
  method: z.enum(["hdfe_regression", "did_static", "did2s", "did_event_study_saturated"]),
  backend: z.literal("pyfixest"),
  pyfixestVersion: z.literal("0.60.0"),
  rowsInput: z.number().int().nonnegative(),
  rowsUsed: z.number().int().positive(),
  droppedRows: z.number().int().nonnegative(),
  coefficients: z.array(CoefficientSchema).min(1),
  primary: CoefficientSchema,
  rSquared: z.number().finite().nullable(),
  rSquaredWithin: z.number().finite().nullable(),
  covariance: z.string().nullable(),
  clusterVars: z.array(z.string()),
  clusterCounts: z.record(z.string(), z.number().int().nonnegative()),
  fixedEffects: z.array(z.string()),
  referencePeriod: z.number().finite().optional(),
  coefficientsPath: z.string().min(1),
  resultPath: z.string().min(1),
  warnings: z.array(z.string()),
}).strict().superRefine((value, ctx) => {
  if (value.rowsUsed > value.rowsInput || value.droppedRows !== value.rowsInput - value.rowsUsed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "样本数量关系不一致" })
  }
})

const FailureResultSchema = z.object({
  success: z.literal(false),
  errorCode: z.string().optional(),
  message: z.string().min(1),
}).passthrough()

export function validatePyfixestBackendResult(input: unknown): PyfixestBackendResult {
  const parsed = SuccessResultSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`PyFixest 结果结构不完整：${parsed.error.issues[0]?.message ?? "未知结构错误"}`)
  }
  return parsed.data
}

function parseLastJsonLine(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch {
      continue
    }
  }
  throw new Error("PyFixest 后端没有返回可解析的结果")
}

export async function runPyfixestBackend(input: {
  pythonCommand: string
  cwd: string
  payload: PyfixestPayload
  abort?: AbortSignal
  timeoutMs?: number
}) {
  fs.mkdirSync(input.payload.outputDir, { recursive: true })
  const runnerPath = path.join(
    input.payload.outputDir,
    `.killstata_pyfixest_runner_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`,
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
      env: {
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
      abort: input.abort,
      timeoutMs: input.timeoutMs ?? 5 * 60 * 1_000,
      maxOutputBytes: 8 * 1024 * 1024,
    })
    if (execution.code !== 0) {
      throw new Error(`PyFixest 后端异常退出（代码 ${execution.code ?? "未知"}）`)
    }

    const rawResult = parseLastJsonLine(execution.stdout)
    const failure = FailureResultSchema.safeParse(rawResult)
    if (failure.success) {
      const code = failure.data.errorCode ? `[${failure.data.errorCode}] ` : ""
      throw new Error(`${code}${failure.data.message || "PyFixest 计量分析失败"}`)
    }
    const result = validatePyfixestBackendResult(rawResult)
    if (result.method !== input.payload.method) {
      throw new Error("PyFixest 返回的计量方法与请求不一致")
    }
    const expectedResultPath = path.resolve(input.payload.outputDir, "results.json")
    const expectedCoefficientsPath = path.resolve(input.payload.outputDir, "coefficients.csv")
    if (
      path.resolve(result.resultPath!) !== expectedResultPath ||
      path.resolve(result.coefficientsPath!) !== expectedCoefficientsPath
    ) {
      throw new Error("PyFixest 返回了不可信的结果路径")
    }
    if (!fs.existsSync(expectedResultPath) || !fs.existsSync(expectedCoefficientsPath)) {
      throw new Error("PyFixest 声明的结果文件不存在")
    }
    return result
  } finally {
    fs.rmSync(runnerPath, { force: true })
  }
}
