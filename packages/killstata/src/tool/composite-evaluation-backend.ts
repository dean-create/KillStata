import fs from "fs"
import path from "path"
import z from "zod"
import { sessionEconometricsEngine } from "@/runtime/services/econometrics-engine-client"
import { econometricsEngineRoot } from "@/killstata/runtime-config"

export const MCDA_METHOD_IDS = ["entropy_weight", "topsis"] as const
export type McdaMethod = (typeof MCDA_METHOD_IDS)[number]

export type CompositeEvaluationPayload = {
  datasetId: string
  stageId: string
  expectedDataFingerprint: string
  method: McdaMethod
  dataPath: string
  outputDir: string
  idColumns: string[]
  indicators: Array<{ column: string; direction: "benefit" | "cost" }>
  scope: "global" | "by_group"
  groupColumns?: string[]
  weightSource?: "equal" | "manual" | "entropy"
  manualWeights?: Record<string, number>
}

const WeightSchema = z.object({ column: z.string().min(1), weight: z.number().finite().min(0) }).strict()
const ScoreRowSchema = z.record(z.string(), z.union([z.string(), z.number().finite()]))
const ResultSchema = z
  .object({
    success: z.literal(true),
    protocolVersion: z.literal(1),
    method: z.enum(MCDA_METHOD_IDS),
    backend: z.literal("numpy-pandas"),
    rowsInput: z.number().int().positive(),
    rowsUsed: z.number().int().positive(),
    scope: z.enum(["global", "by_group"]),
    groupCount: z.number().int().positive(),
    weightSource: z.enum(["equal", "manual", "entropy"]),
    weights: z.array(WeightSchema),
    groupWeights: z.record(z.string(), z.array(WeightSchema)).nullable(),
    scoreColumn: z.string().regex(/^ks_(entropy_weight|topsis)_score$/),
    rankColumn: z.string().regex(/^ks_(entropy_weight|topsis)_rank$/),
    diagnostics: z.array(z.object({ scope: z.string().min(1), rows: z.number().int().positive() }).strict()).min(1),
    top: z.array(ScoreRowSchema).max(5),
    bottom: z.array(ScoreRowSchema).max(5),
    topByGroup: z.record(z.string().min(1), z.array(ScoreRowSchema).max(5)).nullable(),
    warnings: z.array(z.string()),
    scoresPath: z.string().min(1),
    weightsPath: z.string().min(1),
    resultPath: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.rowsUsed !== value.rowsInput) ctx.addIssue({ code: "custom", path: ["rowsUsed"], message: "MCDA 不应静默丢弃样本" })
    if (value.scope === "global" && (value.groupCount !== 1 || value.groupWeights !== null)) {
      ctx.addIssue({ code: "custom", path: ["groupWeights"], message: "全局评价不应返回分组权重" })
    }
    if (value.scope === "global" && value.topByGroup !== null) {
      ctx.addIssue({ code: "custom", path: ["topByGroup"], message: "全局评价不应返回分组预览" })
    }
    if (value.scope === "by_group" && (value.groupCount < 1 || value.groupWeights === null)) {
      ctx.addIssue({ code: "custom", path: ["groupWeights"], message: "分组评价必须返回各组权重" })
    }
    if (value.scope === "by_group" && (value.top.length > 0 || value.bottom.length > 0)) {
      ctx.addIssue({ code: "custom", path: ["top"], message: "分组评价不得返回跨组混排的 top/bottom" })
    }
    if (value.scope === "by_group" && (value.topByGroup === null || Object.keys(value.topByGroup).length !== value.groupCount)) {
      ctx.addIssue({ code: "custom", path: ["topByGroup"], message: "分组评价必须返回与分组数一致的组内排名预览" })
    }
    if (value.method === "entropy_weight" && value.weightSource !== "entropy") {
      ctx.addIssue({ code: "custom", path: ["weightSource"], message: "熵权法必须报告 entropy 权重来源" })
    }
  })

const FailureSchema = z.object({ success: z.literal(false), message: z.string().min(1) }).strict()
export type CompositeEvaluationBackendResult = z.infer<typeof ResultSchema>

function parseSingleJsonLine(stdout: string) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length !== 1) throw new Error("综合评价后端必须只返回一条 JSON 结果")
  try {
    return JSON.parse(lines[0])
  } catch {
    throw new Error("综合评价后端没有返回可解析的 JSON 结果")
  }
}

/** Same untrusted-process boundary as econometrics tools: never trust a successful exit alone. */
export function validateCompositeEvaluationBackendResponse(input: {
  payload: CompositeEvaluationPayload
  stdout: string
}): CompositeEvaluationBackendResult {
  const raw = parseSingleJsonLine(input.stdout)
  const failure = FailureSchema.safeParse(raw)
  if (failure.success) throw new Error(failure.data.message)
  const parsed = ResultSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`综合评价结果结构不完整：${parsed.error.issues[0]?.message ?? "结果校验未指出具体字段"}`)
  const result = parsed.data
  if (result.method !== input.payload.method) throw new Error("综合评价后端返回的方法与请求不一致")
  const expected = {
    scoresPath: path.join(input.payload.outputDir, "scores.parquet"),
    weightsPath: path.join(input.payload.outputDir, "weights.csv"),
    resultPath: path.join(input.payload.outputDir, "results.json"),
  }
  for (const [key, expectedPath] of Object.entries(expected)) {
    const actualPath = result[key as keyof typeof expected]
    if (path.normalize(actualPath) !== path.normalize(expectedPath) || !fs.existsSync(expectedPath)) {
      throw new Error(`综合评价后端返回了不可信的 ${key}`)
    }
  }
  return result
}

export async function runCompositeEvaluationBackend(input: {
  pythonCommand: string
  cwd: string
  payload: CompositeEvaluationPayload
  sessionID?: string
  abort?: AbortSignal
  timeoutMs?: number
  beforeExecute?: () => void
}): Promise<CompositeEvaluationBackendResult> {
  if (input.sessionID) {
    const engine = sessionEconometricsEngine(input.sessionID, {
      command: input.pythonCommand,
      cwd: input.cwd,
      pythonPath: path.join(econometricsEngineRoot(), "src"),
      methodRoot: path.join(econometricsEngineRoot(), "python"),
    })
    const arguments_ = {
      method: input.payload.method,
      idColumns: input.payload.idColumns,
      indicators: input.payload.indicators,
      scope: input.payload.scope,
      groupColumns: input.payload.groupColumns,
      weightSource: input.payload.weightSource,
      manualWeights: input.payload.manualWeights,
    }
    const runtime = {
      datasetId: input.payload.datasetId,
      stageId: input.payload.stageId,
      expectedDataFingerprint: input.payload.expectedDataFingerprint,
    }
    const validation = await engine.validate("composite_evaluation", arguments_, {
      runtime,
      signal: input.abort,
    })
    input.beforeExecute?.()
    fs.mkdirSync(input.payload.outputDir, { recursive: true })
    const response = await engine.execute({
      method_id: "composite_evaluation",
      data_path: input.payload.dataPath,
      output_dir: input.payload.outputDir,
      arguments: validation.arguments,
      runtime,
    }, input.abort)
    const payload = response.payload
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("综合评价引擎返回了空的结构化结果")
    }
    return validateCompositeEvaluationBackendResponse({
      payload: input.payload,
      stdout: JSON.stringify(payload),
    })
  }
  throw new Error("综合评价必须在正式Session中执行；请由CompositeEvaluationTool提供sessionID后重试。")
}
