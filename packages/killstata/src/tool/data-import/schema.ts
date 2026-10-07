import type { DataReadinessReport } from "@/runtime/data-readiness"

// ── 常量 ──

export const DATA_ACTIONS = [
  "import",
  "export",
  "profile",
  "correlation",
  "frequency",
  "validate",
  "healthcheck",
  "rollback",
] as const

export type DataAction = (typeof DATA_ACTIONS)[number]

export const CJK_MOJIBAKE_MARKERS = [
  "鏁版嵁", "鍥炲綊", "缁撴灉", "褰撳墠",
  "鎻愮ず", "绛夊緟", "涓嬩竴姝", "鍙橀噺",
  "妫€鏌", "鍥哄畾", "鏍囬", "璁烘枃",
  "瀛︽湳", "鏁堝簲", "闃舵", "缁堢",
  "杈撳嚭",
] as const

// ── 内部类型 ──

export type PythonResult = {
  success: boolean
  action?: DataAction
  error?: string
  resolved_python_executable?: string
  status?: string
  input_path?: string
  output_path?: string
  summary_path?: string
  log_path?: string
  workbook_path?: string
  numeric_snapshot_path?: string
  inspection_path?: string
  inspection_workbook_path?: string
  dataset_id?: string
  stage_id?: string
  parent_stage_id?: string
  branch?: string
  schema_path?: string
  labels_path?: string
  run_id?: string
  schema_normalization?: Record<string, unknown>
  rows_before?: number
  rows_after?: number
  columns_before?: number
  columns_after?: number
  column_info?: Record<string, string[]>
  /** Excel 工作簿的全部工作表名与本次实际导入的那张；非 Excel 输入为 undefined。 */
  sheet_info?: { names?: string[]; selected?: string }
  metadata_saved?: boolean
  operations_count?: number
  filters_count?: number
  variables?: string[]
  /** profile 动作返回的有界列画像；完整细节保存在结果文件。 */
  profile?: Array<Record<string, unknown>>
  /** frequency/correlation 的结构化计算结果。 */
  frequency?: Array<Record<string, unknown>>
  correlation?: Record<string, Record<string, number | null>>
  warnings?: string[]
  blocking_errors?: string[]
  suggested_repairs?: string[]
  /** 数据质量检查 的说明性备注（非警告）：如识别变量（entity/time）高缺失属设计使然，不算数据质量问题。 */
  notes?: string[]
  module_status?: Record<string, boolean>
  install_command?: string
  missing_before?: Record<string, number>
  missing_after?: Record<string, number>
  import_errors?: string[]
  /** frequency 动作返回的每列高频取值分布，键是列名，值是按 count 倒排后的有界数组 */
  distributions?: Record<string, Array<{ value: string; count: number; share: number }>>
  /** frequency 动作返回的完整数值范围和不同取值总数，独立于有界频数列表 */
  distribution_meta?: Record<string, { numeric?: boolean; min?: number; max?: number; distinct_count: number }>
  /** frequency 动作返回的交叉分组频数（按 groupBy 给出），按 count 倒排后有界 */
  cross_tab?: Array<{ values: string[]; count: number; share: number }>
  /** frequency 动作使用的分组列名 */
  group_by?: string[]
  /** frequency 动作返回的高频取值上限 */
  max_distinct?: number
  /** 上传后自动生成的结构事实与方法候选；不改变原始数据。 */
  readiness?: DataReadinessReport
  /** 上传阶段同步完成的轻量 数据质量检查；warning 不阻断，blockingErrors 才阻断后续估计。 */
  autoQa?: {
    status: "pass" | "warn" | "block"
    warnings: string[]
    blockingErrors: string[]
    suggestedRepairs?: string[]
  }
  /** Python Registry 生成的只读诊断与方法兼容矩阵。 */
  diagnosis?: {
    version: 1
    dataset_id: string
    stage_id: string
    data_fingerprint: string
    rows: number
    columns: string[]
    issues: Array<{ code: string; severity: "info" | "warning" | "blocking"; summary_zh: string; evidence?: Record<string, unknown> }>
    panel_candidates: Array<Record<string, unknown>>
    method_compatibility: Array<{
      method_id: string
      status: "compatible" | "repairable" | "requires_semantic_input" | "incompatible"
      reasons_zh: string[]
      required_repairs: string[]
    }>
    recommended_method_ids: string[]
  }
}

// ── 交付展示常量 ──
