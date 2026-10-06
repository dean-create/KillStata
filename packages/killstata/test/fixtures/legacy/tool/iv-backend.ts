import fs from "fs"
import path from "path"
import z from "zod"
import RUNNER_SCRIPT from "../../../../../killstata-econometrics-engine/python/iv/runner.py" with { type: "text" }
import { runManagedProcess } from "../../../../src/runtime/managed-process"
import { formatBackendExitError, parseLastJsonLine } from "../../../../src/util/parse-last-json-line"
import { runEngineMethodBackend } from "../../../../src/runtime/services/econometrics-engine-backend"

const CONTENT = RUNNER_SCRIPT as unknown as string

export type IvPayload = {
  method: "iv_2sls"
  dataPath: string
  outputDir: string
  dependentVar: string
  treatmentVar: string
  covariates?: string[]
  instrumentVars: string[]
  instrumentJustification?: string
  covariance?: "robust" | "unadjusted"
}
export type IvCoefficient = {
  term: string
  estimate: number | null
  stdError: number | null
  statistic: number | null
  pValue: number | null
  confLow: number | null
  confHigh: number | null
}
export type IvBackendResult = {
  success: boolean
  method?: string
  backend?: string
  linearmodelsVersion?: string
  firstStageF?: number | null
  rowsInput?: number
  rowsUsed?: number
  droppedRows?: number
  covariance?: string
  rSquared?: number | null
  rSquaredAdj?: number | null
  coefficients?: IvCoefficient[]
  primary?: IvCoefficient | null
  resultPath?: string
  coefficientsPath?: string
  warnings?: string[]
  message?: string
}

const CSchema = z
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
const SSchema = z
  .object({
    success: z.literal(true),
    method: z.literal("iv_2sls"),
    backend: z.literal("linearmodels.iv.IV2SLS"),
    linearmodelsVersion: z.string().min(1),
    firstStageF: z.number().finite().nullable(),
    rowsInput: z.number().int().nonnegative(),
    rowsUsed: z.number().int().positive(),
    droppedRows: z.number().int().nonnegative(),
    covariance: z.enum(["robust", "unadjusted"]),
    rSquared: z.number().finite().nullable(),
    rSquaredAdj: z.number().finite().nullable(),
    coefficients: z.array(CSchema).min(2),
    primary: CSchema,
    resultPath: z.string().min(1),
    coefficientsPath: z.string().min(1),
    warnings: z.array(z.string()),
  })
  .strict()
const FSchema = z.object({ success: z.literal(false), message: z.string().min(1) }).passthrough()

export function validateIvBackendResult(i: unknown): IvBackendResult {
  const p = SSchema.safeParse(i)
  if (!p.success) throw new Error(`IV 回归结果结构不完整：${p.error.issues[0]?.message ?? "结果校验未指出具体字段"}`)
  return p.data
}

export async function runIvBackend(input: {
  pythonCommand: string
  cwd: string
  payload: IvPayload
  sessionID?: string
  abort?: AbortSignal
  timeoutMs?: number
  onProgressLine?: (line: string) => void
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
    }) as IvBackendResult
  }
  const rp = path.join(input.payload.outputDir, `.killstata_iv_runner_${process.pid}_${Date.now()}.py`)
  fs.writeFileSync(rp, CONTENT, "utf-8")
  try {
    const e = await runManagedProcess({
      command: input.pythonCommand,
      allowedCommands: [input.pythonCommand],
      args: [rp],
      cwd: input.cwd,
      allowedCwdRoot: input.cwd,
      stdin: JSON.stringify(input.payload),
      env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      abort: input.abort,
      timeoutMs: input.timeoutMs ?? 5 * 60 * 1_000,
      maxOutputBytes: 8 * 1024 * 1024,
      onProgressLine: input.onProgressLine,
    })
    if (e.code !== 0)
      throw new Error(formatBackendExitError("IV", e))
    const raw = parseLastJsonLine(e.stdout, "IV ")
    const fail = FSchema.safeParse(raw)
    if (fail.success) throw new Error(fail.data.message || "IV 回归分析失败")
    const r = validateIvBackendResult(raw)
    if (r.method !== input.payload.method) throw new Error("IV 返回的计量方法与请求不一致")
    const erp = path.resolve(input.payload.outputDir, "results.json")
    const ecp = path.resolve(input.payload.outputDir, "coefficients.csv")
    if (path.resolve(r.resultPath!) !== erp || path.resolve(r.coefficientsPath!) !== ecp)
      throw new Error("IV 返回了不可信的结果路径")
    if (!fs.existsSync(erp) || !fs.existsSync(ecp)) throw new Error("IV 声明的结果文件不存在")
    return r
  } finally {
    fs.rmSync(rp, { force: true })
  }
}
// @ts-nocheck
