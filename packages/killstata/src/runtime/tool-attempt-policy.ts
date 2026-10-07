const DETERMINISTIC_FAILURE_CODES = new Set([
  "INVALID_ARGUMENT",
  "METHOD_INPUT_INVALID",
  "DATA_COLUMN_MISSING",
  "DATA_PANEL_KEY_NOT_UNIQUE",
  "DATA_NO_USABLE_ROWS",
  "DATA_NO_VARIATION",
  "DATA_TOO_FEW_ROWS",
  "DESIGN_MATRIX_RANK_DEFICIENT",
  "DATA_FORMAT_UNSUPPORTED",
  "METHOD_EXECUTION_FAILED",
  "INVALID_METHOD_RESULT",
  "METHOD_NOT_IMPLEMENTED",
  "PREFLIGHT_BLOCKED",
])

/** 通用失败预算；确定性错误由 ledger 按 errorCode 进一步收紧为一次。 */
export function maxToolFailureAttempts(_toolName: string) {
  return 3
}

export function isDeterministicToolFailureCode(errorCode: string | undefined) {
  return typeof errorCode === "string" && DETERMINISTIC_FAILURE_CODES.has(errorCode)
}
