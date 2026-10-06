import fs from "fs"
import path from "path"
import z from "zod"
import RUNNER_SCRIPT from "../../../../../killstata-econometrics-engine/python/iv_test/runner.py" with { type: "text" }
import { runManagedProcess } from "../../../../src/runtime/managed-process"
import { formatBackendExitError, parseLastJsonLine } from "../../../../src/util/parse-last-json-line"
import { runEngineMethodBackend } from "../../../../src/runtime/services/econometrics-engine-backend"

const CONTENT = RUNNER_SCRIPT as unknown as string

export type IvTestPayload = {
  method: "iv_test"
  dataPath: string
  outputDir: string
  dependentVar: string
  treatmentVar: string
  covariates?: string[]
  instrumentVars: string[]
  covariance?: "robust" | "unadjusted"
}

export type IvTestStatistic = { stat: number | null; pValue: number | null; df: number | null }

export type IvTestBackendResult = {
  success: boolean
  method?: string
  backend?: string
  linearmodelsVersion?: string
  dependentVar?: string
  endogenousVar?: string
  instrumentVars?: string[]
  rowsInput?: number
  rowsUsed?: number
  droppedRows?: number
  covariance?: string
  identification?: "just_identified" | "over_identified"
  overIdentifyingRestrictions?: number
  weakInstrument?: {
    firstStageFStat: number
    firstStagePValue: number | null
    partialRSquared: number | null
    threshold: number
    criterion: string
    weak: boolean
  }
  endogeneity?: {
    durbin: IvTestStatistic
    wuHausman: IvTestStatistic
    wooldridgeRegression: IvTestStatistic
    primaryTest: string
    alpha: number
    endogenous: boolean | null
  }
  overIdentification?: {
    applicable: boolean
    reason: string | null
    sargan: IvTestStatistic
    wooldridgeOverid: IvTestStatistic
    primaryTest: string | null
    alpha: number
    instrumentsRejected: boolean | null
  }
  comparison?: {
    olsEstimate: number | null
    olsStdError: number | null
    ivEstimate: number | null
    ivStdError: number | null
  }
  verdict?: string
  resultPath?: string
  testsPath?: string
  warnings?: string[]
  message?: string
}

const StatisticSchema = z
  .object({
    stat: z.number().finite().nullable(),
    pValue: z.number().finite().min(0).max(1).nullable(),
    df: z.number().int().nonnegative().nullable(),
  })
  .strict()

const SuccessSchema = z
  .object({
    success: z.literal(true),
    method: z.literal("iv_test"),
    backend: z.literal("linearmodels.iv.IV2SLS"),
    linearmodelsVersion: z.string().min(1),
    dependentVar: z.string().min(1),
    endogenousVar: z.string().min(1),
    instrumentVars: z.array(z.string().min(1)).min(1),
    rowsInput: z.number().int().nonnegative(),
    rowsUsed: z.number().int().positive(),
    droppedRows: z.number().int().nonnegative(),
    covariance: z.enum(["robust", "unadjusted"]),
    identification: z.enum(["just_identified", "over_identified"]),
    overIdentifyingRestrictions: z.number().int().nonnegative(),
    weakInstrument: z
      .object({
        // 第一阶段 F 是本工具的存在理由：允许它是 null 就等于允许再出一次空头支票。
        firstStageFStat: z.number().finite().nonnegative(),
        firstStagePValue: z.number().finite().min(0).max(1).nullable(),
        partialRSquared: z.number().finite().nullable(),
        threshold: z.number().finite().positive(),
        criterion: z.string().min(1),
        weak: z.boolean(),
      })
      .strict(),
    endogeneity: z
      .object({
        durbin: StatisticSchema,
        wuHausman: StatisticSchema,
        wooldridgeRegression: StatisticSchema,
        primaryTest: z.string().min(1),
        alpha: z.number().finite().positive(),
        endogenous: z.boolean().nullable(),
      })
      .strict(),
    overIdentification: z
      .object({
        applicable: z.boolean(),
        reason: z.string().min(1).nullable(),
        sargan: StatisticSchema,
        wooldridgeOverid: StatisticSchema,
        primaryTest: z.string().min(1).nullable(),
        alpha: z.number().finite().positive(),
        instrumentsRejected: z.boolean().nullable(),
      })
      .strict(),
    comparison: z
      .object({
        olsEstimate: z.number().finite().nullable(),
        olsStdError: z.number().finite().nonnegative().nullable(),
        ivEstimate: z.number().finite().nullable(),
        ivStdError: z.number().finite().nonnegative().nullable(),
      })
      .strict(),
    verdict: z.string().min(1),
    warnings: z.array(z.string()),
    resultPath: z.string().min(1),
    testsPath: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    // 恰好识别时必须给出理由并且不带统计量；过度识别时必须真的算出来。
    const expectedApplicable = value.overIdentifyingRestrictions > 0
    if (value.overIdentification.applicable !== expectedApplicable) {
      ctx.addIssue({ code: "custom", path: ["overIdentification", "applicable"], message: "过度识别适用性与自由度不一致" })
    }
    if (!expectedApplicable && value.overIdentification.sargan.stat !== null) {
      ctx.addIssue({ code: "custom", path: ["overIdentification"], message: "恰好识别不应给出过度识别统计量" })
    }
    if (!expectedApplicable && !value.overIdentification.reason) {
      ctx.addIssue({ code: "custom", path: ["overIdentification", "reason"], message: "不适用时必须说明原因" })
    }
    if (value.rowsUsed > value.rowsInput || value.droppedRows !== value.rowsInput - value.rowsUsed) {
      ctx.addIssue({ code: "custom", path: ["rowsUsed"], message: "样本量核算不一致" })
    }
  })

const FailureSchema = z.object({ success: z.literal(false), message: z.string().min(1) }).passthrough()

export function validateIvTestBackendResult(input: unknown): IvTestBackendResult {
  const parsed = SuccessSchema.safeParse(input)
  if (!parsed.success) throw new Error(`工具变量诊断结果结构不完整：${parsed.error.issues[0]?.message ?? "结果校验未指出具体字段"}`)
  return parsed.data as IvTestBackendResult
}

export async function runIvTestBackend(input: {
  pythonCommand: string
  cwd: string
  payload: IvTestPayload
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
    }) as IvTestBackendResult
  }
  const scriptPath = path.join(
    input.payload.outputDir,
    `.killstata_iv_test_runner_${process.pid}_${Date.now()}.py`,
  )
  fs.writeFileSync(scriptPath, CONTENT, "utf-8")
  try {
    const executed = await runManagedProcess({
      command: input.pythonCommand,
      allowedCommands: [input.pythonCommand],
      args: [scriptPath],
      cwd: input.cwd,
      allowedCwdRoot: input.cwd,
      stdin: JSON.stringify(input.payload),
      env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      abort: input.abort,
      timeoutMs: input.timeoutMs ?? 5 * 60 * 1_000,
      maxOutputBytes: 8 * 1024 * 1024,
    })
    if (executed.code !== 0)
      throw new Error(formatBackendExitError("工具变量诊断", executed))
    const raw = parseLastJsonLine(executed.stdout, "工具变量诊断")
    const failure = FailureSchema.safeParse(raw)
    if (failure.success) throw new Error(failure.data.message || "工具变量诊断失败")
    const result = validateIvTestBackendResult(raw)
    const expectedResult = path.resolve(input.payload.outputDir, "results.json")
    const expectedTests = path.resolve(input.payload.outputDir, "tests.csv")
    if (path.resolve(result.resultPath!) !== expectedResult || path.resolve(result.testsPath!) !== expectedTests)
      throw new Error("工具变量诊断返回了不可信的结果路径")
    if (!fs.existsSync(expectedResult) || !fs.existsSync(expectedTests))
      throw new Error("工具变量诊断声明的结果文件不存在")
    return result
  } finally {
    fs.rmSync(scriptPath, { force: true })
  }
}
// @ts-nocheck
