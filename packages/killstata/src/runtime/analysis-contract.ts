import { isWorkflowEstimateTool } from "./tool-catalog"

export type WorkflowResultContractIssueCode =
  | "RESULT_CONTRACT_INVALID"
  | "RESULT_LINEAGE_MISMATCH"
  | "RESULT_NONFINITE"
  | "RESULT_PATH_INVALID"
  | "RESULT_PATH_MISSING"
  | "CLAIM_CEILING_BLOCKED"

export type WorkflowResultContractIssue = {
  code: WorkflowResultContractIssueCode
  path: string
  message: string
}

export type WorkflowResultContract =
  | { ok: true; checked: boolean; issues: [] }
  | { ok: false; checked: true; issues: WorkflowResultContractIssue[] }

export class WorkflowResultContractError extends Error {
  public readonly code: WorkflowResultContractIssueCode

  public readonly issues: WorkflowResultContractIssue[]

  constructor(issues: WorkflowResultContractIssue[]) {
    const primaryCode = issues[0]?.code ?? "RESULT_CONTRACT_INVALID"
    super([primaryCode, ...issues.map((issue) => `${issue.path}: ${issue.message}`)].join("；"))
    this.name = "WorkflowResultContractError"
    this.code = primaryCode
    this.issues = issues
  }
}

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)
}

function lineageValue(record: RecordValue, ...keys: string[]) {
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key]
  }
  return undefined
}

function isPathKey(key: string) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase()
  return (
    normalized.endsWith("path") &&
    /(artifact|result|output|coefficient|diagnostic|snapshot|summary|inspection|schema|label|log|plot|score|weight|profile|recommendation|test)/.test(
      normalized,
    )
  )
}

function walk(value: unknown, visit: (value: unknown, path: string, key?: string) => void, path = "result") {
  visit(value, path, path.split(".").at(-1))
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${path}[${index}]`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, nested] of Object.entries(value)) {
    walk(nested, visit, `${path}.${key}`)
  }
}

function artifactPathIssues(result: RecordValue) {
  const issues: WorkflowResultContractIssue[] = []
  walk(result, (value, path, key) => {
    if (!key || !isPathKey(key) || value === undefined || value === null) return
    if (typeof value !== "string" || value.trim().length === 0) {
      issues.push({
        code: "RESULT_PATH_INVALID",
        path,
        message: "产物路径必须是非空字符串",
      })
    }
  })
  return issues
}

function nonFiniteIssues(result: RecordValue) {
  const issues: WorkflowResultContractIssue[] = []
  walk(result, (value, path) => {
    if (typeof value !== "number" || Number.isFinite(value)) return
    issues.push({
      code: "RESULT_NONFINITE",
      path,
      message: "统计结果包含非有限数值",
    })
  })
  return issues
}

function hasArtifactPath(result: RecordValue) {
  let found = false
  walk(result, (value, _path, key) => {
    if (found || !key || !isPathKey(key)) return
    if (typeof value === "string" && value.trim().length > 0) found = true
  })
  return found
}

/**
 * 校验工具成功结果的最小运行时契约。
 *
 * 没有 nested `metadata.result` 的旧式 bookkeeping（例如仅记录 workflow
 * profile 状态）不承诺后端结果形状，保持兼容；一旦工具声明了 result，就把
 * 它当作不可信边界重新检查。这里故意不检查文件是否存在：路径解析/存在性
 * 由 workflow artifact verifier 使用真实 workspace 根处理，避免两套路径基准再次漂移。
 */
export function validateWorkflowResultContract(input: {
  toolName: string
  args: Record<string, unknown>
  metadata?: Record<string, unknown>
}): WorkflowResultContract {
  const metadata = input.metadata ?? {}
  if (!("result" in metadata)) return { ok: true, checked: false, issues: [] }

  const result = metadata.result
  if (!isRecord(result)) {
    return {
      ok: false,
      checked: true,
      issues: [
        {
          code: "RESULT_CONTRACT_INVALID",
          path: "metadata.result",
          message: "result 必须是对象",
        },
      ],
    }
  }

  const issues: WorkflowResultContractIssue[] = []
  if (result.success === false) {
    issues.push({
      code: "RESULT_CONTRACT_INVALID",
      path: "metadata.result.success",
      message: "工具声明 success=false，不能记录为 workflow 成功阶段",
    })
  }

  // 新导入的事实来源是 inputPath；datasetId/stageId/runId/branch 可能只是模型从
  // 文件名或旧上下文带来的提示，DataImportTool 会生成本次真实 ID。后续 profile、
  // validate、估计和变换仍严格按调用参数校验血缘，避免把可恢复的导入误判为契约失败。
  const isImport = input.toolName === "data_import" && input.args.action === "import"
  const expectedDatasetId = isImport ? firstString(metadata.datasetId) : firstString(input.args.datasetId, metadata.datasetId)
  // rollback 的输入 stageId 表示“回到哪个父阶段”，后端成功后会创建并返回一个新的
  // stageId；此时不能把父阶段 ID 与新阶段 ID 比成血缘错误。其他数据动作仍必须严格
  // 校验调用参数和结果阶段一致，防止错误产物混入 workflow。
  const isRollback = input.toolName === "data_import" && input.args.action === "rollback"
  const expectedStageId = isRollback || isImport ? undefined : firstString(input.args.stageId, metadata.stageId)
  const expectedRunId = isImport ? firstString(metadata.runId) : firstString(input.args.runId, metadata.runId)
  const expectedBranch = isImport ? firstString(metadata.branch) : firstString(input.args.branch, metadata.branch)
  const lineageChecks: Array<[string, string | undefined, string[]]> = [
    ["datasetId", expectedDatasetId, ["datasetId", "dataset_id"]],
    ["stageId", expectedStageId, ["stageId", "stage_id"]],
    ["runId", expectedRunId, ["runId", "run_id"]],
    ["branch", expectedBranch, ["branch"]],
  ]
  for (const [label, expected, keys] of lineageChecks) {
    if (!expected) continue
    const actual = lineageValue(result, ...keys)
    if (actual !== undefined && actual !== expected) {
      issues.push({
        code: "RESULT_LINEAGE_MISMATCH",
        path: `metadata.result.${keys[0]}`,
        message: `${label} 与本次工具调用不一致（expected=${expected}, actual=${actual}）`,
      })
    }
  }

  issues.push(...nonFiniteIssues(result), ...artifactPathIssues(result))

  const principleChecks = isRecord(result.principle_checks) ? result.principle_checks : undefined
  if (principleChecks?.claim_ceiling === "blocked") {
    issues.push({
      code: "CLAIM_CEILING_BLOCKED",
      path: "metadata.result.principle_checks.claim_ceiling",
      message: "结果声明上限为 blocked，不得作为可报告的完整结论",
    })
  }
  // 一组数字却没有任何可追溯产物。仅对真正的 estimator 生效，避免影响 profile
  // 和数据诊断这类合法的结构化结果。
  if (isWorkflowEstimateTool(input.toolName) && result.success !== false && !hasArtifactPath(result)) {
    issues.push({
      code: "RESULT_PATH_MISSING",
      path: "metadata.result",
      message: "估计结果没有声明任何可追溯产物路径",
    })
  }

  return issues.length > 0
    ? { ok: false, checked: true, issues }
    : { ok: true, checked: true, issues: [] }
}
