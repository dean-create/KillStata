import fs from "fs"
import path from "path"
import z from "zod"
import RUNNER_SCRIPT from "../../../../../killstata-econometrics-engine/python/panel/runner.py" with { type: "text" }
import { runManagedProcess } from "../../../../src/runtime/managed-process"
import { formatBackendExitError, parseLastJsonLine } from "../../../../src/util/parse-last-json-line"
import { runEngineMethodBackend } from "../../../../src/runtime/services/econometrics-engine-backend"

export type PanelMethod = "panel_random_effects"

export type PanelPayload = {
  method: PanelMethod
  dataPath: string
  outputDir: string
  dependentVar: string
  treatmentVar: string
  covariates?: string[]
  entityVar: string
  timeVar: string
  covariance?: "robust" | "unadjusted"
}

export type PanelCoefficient = {
  term: string
  estimate: number | null
  stdError: number | null
  statistic: number | null
  pValue: number | null
  confLow: number | null
  confHigh: number | null
}

export type PanelHausman = {
  statistic: number | null
  df: number
  pValue: number | null
  alpha: number
  rejectRe: boolean | null
}

export type PanelBackendResult = {
  success: boolean
  method?: PanelMethod
  backend?: "linearmodels"
  statsmodelsVersion?: string
  linearmodelsVersion?: string
  rowsInput?: number
  rowsUsed?: number
  droppedRows?: number
  covariance?: string
  entityVar?: string
  timeVar?: string
  nEntities?: number
  nPeriods?: number
  randomEffects?: {
    coefficients: PanelCoefficient[]
    primary: PanelCoefficient | null
    sigmaEntity: number | null
  }
  fixedEffects?: {
    coefficients: PanelCoefficient[]
    primary: PanelCoefficient | null
  }
  hausman?: PanelHausman
  recommendation?: { preferred: "fixed_effects" | "random_effects" | "undetermined"; reason: string }
  resultPath?: string
  coefficientsPath?: string
  warnings?: string[]
  message?: string
}

export function isHausmanUndetermined(hausman: Partial<PanelHausman> | undefined) {
  return hausman?.df === undefined
    || hausman.df === 0
    || hausman.statistic == null
    || hausman.pValue == null
    || hausman.rejectRe == null
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

const HausmanSchema = z
  .object({
    statistic: z.number().finite().nonnegative().nullable(),
    df: z.number().int().nonnegative(),
    pValue: z.number().finite().min(0).max(1).nullable(),
    alpha: z.number().finite(),
    rejectRe: z.boolean().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.df === 0 && value.statistic !== null && value.statistic > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "df=0 时统计量必须为 0" })
    }
  })

const SuccessResultSchema = z
  .object({
    success: z.literal(true),
    method: z.literal("panel_random_effects"),
    backend: z.literal("linearmodels"),
    statsmodelsVersion: z.string().min(1),
    linearmodelsVersion: z.string().min(1),
    rowsInput: z.number().int().nonnegative(),
    rowsUsed: z.number().int().positive(),
    droppedRows: z.number().int().nonnegative(),
    covariance: z.enum(["robust", "unadjusted"]),
    entityVar: z.string().min(1),
    timeVar: z.string().min(1),
    nEntities: z.number().int().positive(),
    nPeriods: z.number().int().positive(),
    randomEffects: z
      .object({
        coefficients: z.array(CoefficientSchema).min(1),
        primary: CoefficientSchema,
        sigmaEntity: z.number().finite().nonnegative().nullable(),
      })
      .strict(),
    fixedEffects: z
      .object({
        coefficients: z.array(CoefficientSchema).min(1),
        primary: CoefficientSchema,
      })
      .strict(),
    hausman: HausmanSchema,
    recommendation: z
      .object({
        preferred: z.enum(["fixed_effects", "random_effects", "undetermined"]),
        reason: z.string().min(1),
      })
      .strict(),
    warnings: z.array(z.string()),
    resultPath: z.string().min(1),
    coefficientsPath: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.rowsUsed > value.rowsInput || value.droppedRows !== value.rowsInput - value.rowsUsed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "样本数量关系不一致" })
    }
    // 至少 2 个个体、2 期才能跑面板
    if (value.nEntities < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "面板个体数过少" })
    }
    if (value.nPeriods < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "面板时间期数过少" })
    }
    if (isHausmanUndetermined(value.hausman)) {
      if (value.hausman.rejectRe !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Hausman 检验不可判定时不能提供拒绝标记" })
      }
      if (value.recommendation.preferred !== "undetermined") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Hausman 检验不可判定时不能推荐 FE 或 RE" })
      }
    } else {
      const expectedRecommendation = value.hausman.rejectRe === true ? "fixed_effects" : "random_effects"
      if (value.recommendation.preferred !== expectedRecommendation) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Hausman 检验结论与模型推荐不一致" })
      }
    }
  })

const FailureResultSchema = z
  .object({
    success: z.literal(false),
    message: z.string().min(1),
  })
  .passthrough()

export function validatePanelBackendResult(input: unknown): PanelBackendResult {
  const parsed = SuccessResultSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(`面板随机效应结果结构不完整：${parsed.error.issues[0]?.message ?? "未知结构错误"}`)
  }
  return parsed.data
}

export async function runPanelBackend(input: {
  pythonCommand: string
  cwd: string
  payload: PanelPayload
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
    }) as PanelBackendResult
  }
  const runnerPath = path.join(
    input.payload.outputDir,
    `.killstata_panel_runner_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`,
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
      throw new Error(formatBackendExitError("面板随机效应", execution))
    }
    const rawResult = parseLastJsonLine(execution.stdout, "面板随机效应")
    const failure = FailureResultSchema.safeParse(rawResult)
    if (failure.success) {
      throw new Error(failure.data.message || "面板随机效应分析失败")
    }
    const result = validatePanelBackendResult(rawResult)
    if (result.method !== input.payload.method) {
      throw new Error("面板随机效应返回的计量方法与请求不一致")
    }
    const expectedResultPath = path.resolve(input.payload.outputDir, "results.json")
    const expectedCoefficientsPath = path.resolve(input.payload.outputDir, "coefficients.csv")
    if (
      path.resolve(result.resultPath!) !== expectedResultPath ||
      path.resolve(result.coefficientsPath!) !== expectedCoefficientsPath
    ) {
      throw new Error("面板随机效应返回了不可信的结果路径")
    }
    if (!fs.existsSync(expectedResultPath) || !fs.existsSync(expectedCoefficientsPath)) {
      throw new Error("面板随机效应声明的结果文件不存在")
    }
    return result
  } finally {
    fs.rmSync(runnerPath, { force: true })
  }
}
// @ts-nocheck
