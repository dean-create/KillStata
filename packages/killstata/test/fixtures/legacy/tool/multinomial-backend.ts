import fs from "fs"
import path from "path"
import z from "zod"
import RUNNER_SCRIPT from "../../../../../killstata-econometrics-engine/python/multinomial/runner.py" with { type: "text" }
import { runManagedProcess } from "../../../../src/runtime/managed-process"
import { formatBackendExitError, parseLastJsonLine } from "../../../../src/util/parse-last-json-line"
import { runEngineMethodBackend } from "../../../../src/runtime/services/econometrics-engine-backend"

export type MultinomialMethod = "multinomial_logit"

export type MultinomialPayload = {
  method: MultinomialMethod
  dataPath: string
  outputDir: string
  dependentVar: string
  treatmentVar: string
  covariates?: string[]
  covariance?: "nonrobust" | "robust"
}

const CoefficientSchema = z
  .object({
    category: z.number().int(),
    term: z.string().min(1),
    estimate: z.number().finite(),
    stdError: z.number().finite().nonnegative(),
    pValue: z.number().finite().min(0).max(1),
    confLow: z.number().finite().nullable(),
    confHigh: z.number().finite().nullable(),
    rrr: z.number().finite().positive(),
  })
  .strict()

const TreatmentPathSchema = z
  .object({
    category: z.number().int(),
    estimate: z.number().finite(),
    stdError: z.number().finite().nonnegative(),
    pValue: z.number().finite().min(0).max(1),
    confLow: z.number().finite().nullable(),
    confHigh: z.number().finite().nullable(),
    rrr: z.number().finite().positive(),
  })
  .strict()

const SuccessResultSchema = z
  .object({
    success: z.literal(true),
    method: z.literal("multinomial_logit"),
    backend: z.literal("statsmodels"),
    statsmodelsVersion: z.string().min(1),
    rowsInput: z.number().int().nonnegative(),
    rowsUsed: z.number().int().positive(),
    droppedRows: z.number().int().nonnegative(),
    covariance: z.enum(["nonrobust", "HC1"]),
    categories: z.array(z.number().int()).min(2).max(20),
    baselineCategory: z.number().int(),
    nCategories: z.number().int().min(2).max(20),
    compareCategories: z.array(z.number().int()).min(1),
    logLikelihood: z.number().finite().nullable(),
    pseudoRSquared: z.number().finite().nullable(),
    accuracy: z.number().finite().min(0).max(1),
    coefficients: z.array(CoefficientSchema).min(2),
    treatmentPath: z.array(TreatmentPathSchema).min(1),
    primary: CoefficientSchema.nullable(),
    primaryRrr: TreatmentPathSchema.nullable(),
    warnings: z.array(z.string()),
    resultPath: z.string().min(1),
    coefficientsPath: z.string().min(1),
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

export function validateMultinomialBackendResult(input: unknown): z.infer<typeof SuccessResultSchema> {
  const parsed = SuccessResultSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`多分类 Logit 结果结构不完整：${parsed.error.issues[0]?.message ?? "未知结构错误"}`)
  }
  return parsed.data
}

export async function runMultinomialBackend(input: {
  pythonCommand: string
  cwd: string
  payload: MultinomialPayload
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
    }) as Awaited<ReturnType<typeof validateMultinomialBackendResult>>
  }
  const runnerPath = path.join(
    input.payload.outputDir,
    `.killstata_multinomial_runner_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`,
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
      throw new Error(formatBackendExitError("多分类 Logit", execution))
    }
    const rawResult = parseLastJsonLine(execution.stdout, "多分类 Logit")
    const failure = FailureResultSchema.safeParse(rawResult)
    if (failure.success) throw new Error(failure.data.message || "多分类 Logit 分析失败")
    const result = validateMultinomialBackendResult(rawResult)
    if (result.method !== input.payload.method) throw new Error("多分类 Logit 返回方法与请求不一致")
    const erp = path.resolve(input.payload.outputDir, "results.json")
    const ecp = path.resolve(input.payload.outputDir, "coefficients.csv")
    if (path.resolve(result.resultPath!) !== erp || path.resolve(result.coefficientsPath!) !== ecp) {
      throw new Error("多分类 Logit 返回了不可信的结果路径")
    }
    if (!fs.existsSync(erp) || !fs.existsSync(ecp)) throw new Error("多分类 Logit 声明的结果文件不存在")
    return result
  } finally {
    fs.rmSync(runnerPath, { force: true })
  }
}
// @ts-nocheck
