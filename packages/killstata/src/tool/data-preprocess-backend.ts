import fs from "fs"
import path from "path"
import z from "zod"
import { sessionEconometricsEngine } from "@/runtime/services/econometrics-engine-client"
import { econometricsEngineRoot } from "@/killstata/runtime-config"
import { formatBackendExitError, parseLastJsonLine } from "@/util/parse-last-json-line"
import type { DataReadinessReport } from "@/runtime/data-readiness"

export const PREPROCESS_METHOD_IDS = [
  "listwise_deletion",
  "mean_impute",
  "median_impute",
  "knn_impute",
  "zscore_detect",
  "iqr_detect",
  "winsorize",
  "trim",
  "zscore_standardize",
  "minmax_scale",
  "robust_scale",
  "log_transform",
  "boxcox_transform",
  "yeojohnson_transform",
  "fill_constant",
  "forward_fill",
  "backward_fill",
  "linear_interpolate",
  "group_linear_interpolate",
  "regression_impute",
  "create_dummies",
  "combine_columns",
  "filter",
  "create_column",
  "create_relative_time",
  "coerce_numeric",
] as const

export type PreprocessMethod = (typeof PREPROCESS_METHOD_IDS)[number]

export type DataPreprocessPayload = {
  datasetId: string
  stageId: string
  method: PreprocessMethod
  dataPath: string
  outputPath: string
  columns: string[]
  options?: Record<string, unknown>
  modelArguments?: Record<string, unknown>
}

const BackendSuccessSchema = z
  .object({
    success: z.literal(true),
    method: z.enum(PREPROCESS_METHOD_IDS),
    mutation: z.boolean(),
    rows_before: z.number().int().nonnegative(),
    rows_after: z.number().int().nonnegative(),
    columns_before: z.number().int().positive(),
    columns_after: z.number().int().positive(),
    operation: z.string().min(1).optional(),
    rows_changed: z.number().int().optional(),
    columns_changed: z.number().int().optional(),
    affected_columns: z.array(z.string().min(1)).optional(),
    created_columns: z.array(z.string().min(1)).optional(),
    warnings: z.array(z.string()).default([]),
    changed_cells: z.number().int().nonnegative().optional(),
    new_columns: z.array(z.string().min(1)).optional(),
    dropped_columns: z.array(z.string().min(1)).optional(),
    output_path: z.string().min(1).optional(),
    rows_dropped: z.number().int().nonnegative().optional(),
    strategy: z.enum(["mean", "median", "mode", "constant", "forward", "backward"]).optional(),
    missing_before: z.record(z.string(), z.number().int().nonnegative()).optional(),
    missing_after: z.record(z.string(), z.number().int().nonnegative()).optional(),
    lower: z.number().finite().optional(),
    upper: z.number().finite().optional(),
    offset: z.number().finite().optional(),
    new_columns_detail: z.array(z.string().min(1)).optional(),
    detected: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    lambda: z.record(z.string(), z.number().finite()).optional(),
    k: z.number().int().positive().optional(),
    shift: z.number().finite().nullish(),
    rules_count: z.number().int().nonnegative().optional(),
    rules: z.array(z.unknown()).optional(),
    time_var: z.string().optional(),
    group_by: z.array(z.string()).optional(),
    predictors: z.array(z.string()).optional(),
    output_column: z.string().optional(),
    separator: z.string().optional(),
    converted_numeric: z.array(z.string().min(1)).optional(),
    missing_tokens_applied: z.array(z.string()).optional(),
    missing_tokens_converted: z.record(z.string(), z.number().int().nonnegative()).optional(),
    rows_retained: z.number().int().nonnegative().optional(),
    drop_first: z.boolean().optional(),
    // create_column 参数回传
    operator: z.string().optional(),
    right_column: z.string().nullish(),
    right_value: z.union([z.number(), z.string()]).nullish(),
    true_count: z.number().int().nonnegative().optional(),
    false_count: z.number().int().nonnegative().optional(),
    // 变更方法会创建新 stage，新 stage 的就绪事实由 runner 基于新数据重算后回传。
    // schema 是 strict 的，不显式声明会被整体拒收。结构校验仍在 TS 侧按
    // DataReadinessReport 做，这里只保证字段能穿过后端契约。
    readiness: z.record(z.string(), z.unknown()).optional(),
    readiness_error: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.rows_after > value.rows_before && value.method === "listwise_deletion") {
      ctx.addIssue({ code: "custom", path: ["rows_after"], message: "删除缺失行不能增加样本量" })
    }
    if (value.mutation !== Boolean(value.output_path)) {
      ctx.addIssue({ code: "custom", path: ["output_path"], message: "变更操作与输出文件声明不一致" })
    }
  })

const BackendFailureSchema = z
  .object({
    success: z.literal(false),
    error_code: z.string().min(1),
    error: z.string().min(1),
  })
  .strict()

export type DataPreprocessBackendResult = {
  success: true
  method: PreprocessMethod
  mutation: boolean
  rowsBefore: number
  rowsAfter: number
  columnsBefore: number
  columnsAfter: number
  operation?: string
  createdColumns?: string[]
  warnings: string[]
  changedCells?: number
  newColumns: string[]
  droppedColumns: string[]
  outputPath?: string
  rowsDropped?: number
  convertedNumeric?: string[]
  missingTokensApplied?: string[]
  missingTokensConverted?: Record<string, number>
  rowsRetained?: number
  missingBefore?: Record<string, number>
  missingAfter?: Record<string, number>
  detected?: Record<string, Record<string, unknown>>
  lambda?: Record<string, number>
  /** 变更方法创建新 stage 时，由 runner 基于新数据重算的就绪事实。 */
  readiness?: DataReadinessReport
  /** 重算失败的稳定标识；不吞掉，交给 TS 侧给模型明确的下一步。 */
  readinessError?: string
}

function normalizePath(value: string) {
  return path.normalize(value)
}

/**
 * 受管子进程是不可信边界：即使 Python 退出码为 0，也必须重新校验单行 JSON、
 * method、行数不变量和输出路径。导出此函数是为了让对抗测试能覆盖伪造返回，
 * 而不是只依赖正常 runner 的 happy path。
 */
export function validateDataPreprocessBackendResponse(input: {
  payload: DataPreprocessPayload
  stdout: string
}): DataPreprocessBackendResult {
  const raw = parseLastJsonLine(input.stdout, "数据预处理", true)
  const failure = BackendFailureSchema.safeParse(raw)
  if (failure.success) throw new Error(`${failure.data.error_code}: ${failure.data.error}`)
  const parsed = BackendSuccessSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    throw new Error(`数据预处理结果结构不完整：${issues}`)
  }
  const result = parsed.data
  if (result.method !== input.payload.method) throw new Error("后端返回的方法与请求不一致")
  if (result.mutation) {
    if (!result.output_path || normalizePath(result.output_path) !== normalizePath(input.payload.outputPath)) {
      throw new Error("数据预处理后端返回了不可信的输出路径")
    }
    if (!fs.existsSync(input.payload.outputPath)) throw new Error("数据预处理后端声明的输出文件不存在")
  }
  return {
    success: true,
    method: result.method,
    mutation: result.mutation,
    rowsBefore: result.rows_before,
    rowsAfter: result.rows_after,
    columnsBefore: result.columns_before,
    columnsAfter: result.columns_after,
    operation: result.operation,
    createdColumns: result.created_columns,
    warnings: result.warnings,
    changedCells: result.changed_cells,
    newColumns: result.new_columns ?? [],
    droppedColumns: result.dropped_columns ?? [],
    outputPath: result.output_path,
    rowsDropped: result.rows_dropped,
    convertedNumeric: result.converted_numeric,
    missingTokensApplied: result.missing_tokens_applied,
    missingTokensConverted: result.missing_tokens_converted,
    rowsRetained: result.rows_retained,
    missingBefore: result.missing_before,
    missingAfter: result.missing_after,
    detected: result.detected,
    lambda: result.lambda,
    readiness: result.readiness as DataReadinessReport | undefined,
    readinessError: result.readiness_error,
  }
}

export async function runDataPreprocessBackend(input: {
  pythonCommand: string
  cwd: string
  payload: DataPreprocessPayload
  sessionID?: string
  abort?: AbortSignal
  timeoutMs?: number
}): Promise<DataPreprocessBackendResult> {
  if (input.sessionID) {
    const engine = sessionEconometricsEngine(input.sessionID, {
      command: input.pythonCommand,
      cwd: input.cwd,
      pythonPath: path.join(econometricsEngineRoot(), "src"),
      methodRoot: path.join(econometricsEngineRoot(), "python"),
    })
    const response = await engine.execute({
      method_id: "data_preprocess",
      data_path: input.payload.dataPath,
      output_dir: path.dirname(input.payload.outputPath),
      arguments: input.payload.modelArguments ?? {
        method: input.payload.method,
        columns: input.payload.columns,
        options: input.payload.options ?? {},
      },
      runtime: {
        datasetId: input.payload.datasetId,
        stageId: input.payload.stageId,
        outputPath: input.payload.outputPath,
      },
    }, input.abort)
    const payload = response.payload
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("数据预处理引擎返回了空的结构化结果")
    }
    return validateDataPreprocessBackendResponse({
      payload: input.payload,
      stdout: JSON.stringify(payload),
    })
  }

  throw new Error("数据预处理必须在正式Session中执行；请由DataPreprocessTool提供sessionID后重试。")
}
