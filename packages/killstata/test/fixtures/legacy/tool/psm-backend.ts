import fs from "fs"
import path from "path"
import z from "zod"
import RUNNER_SCRIPT from "../../../../../killstata-econometrics-engine/python/psm/runner.py" with { type: "text" }
import { runManagedProcess } from "../../../../src/runtime/managed-process"
import { realPathOrSelf } from "../../../../src/tool/analysis-path"
import { formatBackendExitError, parseLastJsonLine } from "../../../../src/util/parse-last-json-line"
import { runEngineMethodBackend } from "../../../../src/runtime/services/econometrics-engine-backend"

/**
 * psm-backend.ts — 单一的 PSM Python runner 调用层
 *
 * 6 个 PSM 方法共享同一个 Python 后端（python/psm/runner.py），
 * 本文件封装了调用 runner、解析输出、验证结果的全部逻辑。
 * 具体的每前端工具（psm_construction、psm_matching 等）只需调用 runPsmMethod
 * 并设置标题即可。
 */

// ── 公共 payload 类型 ──

export type PsmMethod =
  | "psm_construction"
  | "psm_matching"
  | "psm_ipw"
  | "psm_regression"
  | "psm_double_robust"
  | "psm_visualize"

export type PsmPayload = {
  method: PsmMethod
  dataPath: string
  outputDir: string
  dependentVar?: string
  treatmentVar: string
  covariates: string[]
  analysisUnitVar?: string
  preTreatmentAggregation?: "not_applicable" | "baseline" | "pre_treatment_mean"
}

// ── psm_construction 结果 ──

export type PsmConstructionResult = {
  success: true
  method: "psm_construction"
  backend: string
  rowsInput: number
  rowsUsed: number
  propensityScoresPath: string
  scoreMin: number
  scoreMax: number
  meanTreated: number
  meanControl: number
  extremeScoreShare: number
  supportLower: number | null
  supportUpper: number | null
  shareInSupport: number | null
  logitIterations: number
  resultPath: string
  warnings: string[]
}

// ── psm_matching 结果 ──

export type PsmMatchingResult = {
  success: true
  method: "psm_matching"
  backend: string
  rowsInput: number
  rowsUsed: number
  att: number
  caliper: number
  treatedCount: number
  controlCount: number
  matchedTreatedCount: number
  unmatchedTreatedCount: number
  reusedControlCount: number
  maxMatchDistance: number
  preMatchSmd: Record<string, number>
  postMatchSmd: Record<string, number>
  preMatchMaxAbsSmd: number
  postMatchMaxAbsSmd: number
  resultPath: string
  warnings: string[]
}

// ── psm_ipw / psm_regression / psm_double_robust 结果 ──

export type PsmAteResult = {
  success: true
  method: PsmMethod
  backend: string
  rowsInput: number
  rowsUsed: number
  ate: number
  treatedCount: number
  controlCount: number
  treatmentEss: number
  controlEss: number
  minPropensityScore: number
  maxPropensityScore: number
  maxWeight: number
  weightedSmd: Record<string, number>
  weightedMaxAbsSmd: number
  resultPath: string
  diagnostics_path?: string
  output_path?: string
  warnings: string[]
  // 以下字段由 TS 侧计算，不在 Python runner 中设定
  principle_checks: {
    method: string
    prereq_status: "pass" | "warn" | "block"
    diagnostics_status: "pass" | "warn" | "block"
    claim_ceiling: "full" | "restricted" | "blocked"
    findings: string[]
  }
}

// ── psm_visualize 结果 ──

export type PsmVisualizeResult = {
  success: true
  method: "psm_visualize"
  backend: string
  rowsInput: number
  rowsUsed: number
  plotPath: string
  scoreMin: number
  scoreMax: number
  meanTreated: number
  meanControl: number
  extremeScoreShare: number
  supportLower: number | null
  supportUpper: number | null
  shareInSupport: number | null
  treatedCount: number
  controlCount: number
  resultPath: string
  warnings: string[]
}

export type PsmBackendResult =
  | PsmConstructionResult
  | PsmMatchingResult
  | PsmAteResult
  | PsmVisualizeResult

// ── 失败结果 ──

type PsmFailure = {
  success: false
  message: string
}

export type PsmDiagnosticPrecondition = "treatment_not_binary"

export type PsmDiagnosticBlockedResult = {
  success: false
  method: "psm_construction" | "psm_visualize"
  precondition: PsmDiagnosticPrecondition
  message: string
}

/**
 * 诊断工具的确定性前提失败不应进入“换参数重试”路径。
 * 例如把面板筛到单一年份后，处理变量可能只剩 0 或只剩 1；这是输入阶段
 * 的设计问题，不是 Python 暂时故障。统一在后端边界分类，供工具层转成可操作
 * 的用户决策结果。
 */
export function classifyPsmDiagnosticPrecondition(message: string): PsmDiagnosticPrecondition | undefined {
  if (/Treatment must be binary 0\/1/i.test(message)) return "treatment_not_binary"
  return undefined
}

export function formatPsmDiagnosticPreconditionMessage(treatmentVar: string): string {
  return `当前诊断阶段的处理变量“${treatmentVar}”没有同时包含 0 和 1，无法构造倾向得分分布。请回到包含处理组和对照组的阶段；不要先按单一年份筛选后再做 PSM 诊断。`
}

export function isPsmDiagnosticBlockedResult(result: PsmBackendResult | PsmDiagnosticBlockedResult): result is PsmDiagnosticBlockedResult {
  return result.success === false && (result as PsmDiagnosticBlockedResult).precondition === "treatment_not_binary"
}

// ── 公共结构校验契约 ──

const SuccessBase = z.object({
  success: z.literal(true),
  method: z.string().min(1),
  backend: z.string().min(1),
  rowsInput: z.number().int().nonnegative(),
  rowsUsed: z.number().int().positive(),
  resultPath: z.string().min(1),
  warnings: z.array(z.string()),
})

const PsmConstructionSchema = SuccessBase.extend({
  method: z.literal("psm_construction"),
  propensityScoresPath: z.string().min(1),
  scoreMin: z.number().finite(),
  scoreMax: z.number().finite(),
  meanTreated: z.number().finite(),
  meanControl: z.number().finite(),
  extremeScoreShare: z.number().finite(),
  supportLower: z.number().finite().nullable(),
  supportUpper: z.number().finite().nullable(),
  shareInSupport: z.number().finite().nullable(),
  logitIterations: z.number().int().nonnegative(),
}).strict()

const PsmMatchingSchema = SuccessBase.extend({
  method: z.literal("psm_matching"),
  att: z.number().finite(),
  caliper: z.number().finite().positive(),
  treatedCount: z.number().int().nonnegative(),
  controlCount: z.number().int().nonnegative(),
  matchedTreatedCount: z.number().int().nonnegative(),
  unmatchedTreatedCount: z.number().int().nonnegative(),
  reusedControlCount: z.number().int().nonnegative(),
  maxMatchDistance: z.number().finite(),
  preMatchSmd: z.record(z.string(), z.number()),
  postMatchSmd: z.record(z.string(), z.number()),
  preMatchMaxAbsSmd: z.number().finite(),
  postMatchMaxAbsSmd: z.number().finite(),
}).strict()

const PsmAteSchema = SuccessBase.extend({
  method: z.enum(["psm_ipw", "psm_regression", "psm_double_robust"]),
  ate: z.number().finite(),
  treatedCount: z.number().int().nonnegative(),
  controlCount: z.number().int().nonnegative(),
  treatmentEss: z.number().finite().positive(),
  controlEss: z.number().finite().positive(),
  minPropensityScore: z.number().finite(),
  maxPropensityScore: z.number().finite(),
  maxWeight: z.number().finite().positive(),
  weightedSmd: z.record(z.string(), z.number()),
  weightedMaxAbsSmd: z.number().finite(),
  diagnostics_path: z.string().min(1).optional(),
  output_path: z.string().min(1).optional(),
})

const PsmVisualizeSchema = SuccessBase.extend({
  method: z.literal("psm_visualize"),
  plotPath: z.string().min(1),
  scoreMin: z.number().finite(),
  scoreMax: z.number().finite(),
  meanTreated: z.number().finite(),
  meanControl: z.number().finite(),
  extremeScoreShare: z.number().finite(),
  supportLower: z.number().finite().nullable(),
  supportUpper: z.number().finite().nullable(),
  shareInSupport: z.number().finite().nullable(),
  treatedCount: z.number().int().nonnegative(),
  controlCount: z.number().int().nonnegative(),
}).strict()

const FailureSchema = z.object({
  success: z.literal(false),
  message: z.string().min(1),
}).strict()

// ── 主入口 ──

export async function runPsmBackend(input: {
  pythonCommand: string
  cwd: string
  payload: PsmPayload
  sessionID?: string
  abort?: AbortSignal
  timeoutMs?: number
  onProgressLine?: (line: string) => void
}): Promise<PsmBackendResult> {
  if (input.sessionID) {
    return await runEngineMethodBackend({
      sessionID: input.sessionID,
      pythonCommand: input.pythonCommand,
      cwd: input.cwd,
      methodID: input.payload.method,
      payload: input.payload as unknown as Record<string, unknown>,
      abort: input.abort,
    }) as PsmBackendResult
  }
  const runnerPath = path.join(
    input.payload.outputDir,
    `.killstata_psm_runner_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`,
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
      // runner 被写到 outputDir 执行，其 __file__ 已脱离源码树，
      // 必须显式告诉它 econometric_algorithm.py 的真实位置。
      env: {
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        KILLSTATA_PSM_CORE_DIR: path.join(__dirname, "../../../killstata-econometrics-engine/python/econometrics"),
      },
      abort: input.abort,
      timeoutMs: input.timeoutMs ?? 5 * 60 * 1_000,
      maxOutputBytes: 8 * 1024 * 1024,
      onProgressLine: input.onProgressLine,
    })

    if (execution.code !== 0) {
      throw new Error(formatBackendExitError("PSM", execution))
    }

    const rawResult = parseLastJsonLine(execution.stdout, "Python ")

    // 先检查 success 字段快速拒绝失败响应，避免两轮 Zod parse
    if (rawResult && typeof rawResult === "object" && (rawResult as Record<string, unknown>).success === false) {
      FailureSchema.parse(rawResult)
      throw new Error((rawResult as Record<string, unknown>).message as string || "PSM 分析失败")
    }

    const method = input.payload.method
    const schema = SCHEMA_FOR_METHOD[method]
    if (!schema) {
      throw new Error(`未注册的 PSM 方法：${method}`)
    }
    const parsed = schema.safeParse(rawResult)
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".")}：${i.message}`).join("；")
      throw new Error(`PSM 返回结果结构不合法：${detail}`)
    }

    const result = parsed.data as { resultPath: string }
    const expectedResultPath = path.resolve(input.payload.outputDir, "results.json")
    // Python 侧用 Path.resolve() 写回路径，会解开 symlink（macOS 下 /tmp → /private/tmp），
    // 而 path.resolve() 不解；两边都取实路径后再比对，避免把合法结果误判为不可信。
    if (realPathOrSelf(result.resultPath) !== realPathOrSelf(expectedResultPath)) {
      throw new Error("PSM 返回了不可信的结果路径")
    }
    if (!fs.existsSync(expectedResultPath)) {
      throw new Error("PSM 声明的结果文件不存在")
    }

    const aliased = withSnakeCaseAliases(result) as Record<string, unknown>

    return aliased as PsmBackendResult
  } finally {
    fs.rmSync(runnerPath, { force: true })
  }
}

/**
 * PSM 结果对外同时暴露 camelCase 与 snake_case 两种键。
 *
 * Python runner 产出 camelCase，而工具结果的既有消费契约（含冻结的验收测试）读
 * snake_case；在后端出口补别名可让两种读法一致，避免每个方法各写一份映射。
 */
function withSnakeCaseAliases<T extends Record<string, unknown>>(result: T): T {
  const aliased: Record<string, unknown> = { ...result }
  for (const [key, value] of Object.entries(result)) {
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    if (snake !== key && !(snake in aliased)) aliased[snake] = value
  }
  return aliased as T
}

const SCHEMA_FOR_METHOD: Record<string, z.ZodSchema> = {
  psm_construction: PsmConstructionSchema,
  psm_matching: PsmMatchingSchema,
  psm_ipw: PsmAteSchema,
  psm_regression: PsmAteSchema,
  psm_double_robust: PsmAteSchema,
  psm_visualize: PsmVisualizeSchema,
}
// @ts-nocheck
