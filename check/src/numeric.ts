export type NumericResult = {
  rowsUsed: number
  coefficient: number
  stdError: number
}

const COEFFICIENT_ABS_TOLERANCE = 1e-8
const STANDARD_ERROR_ABS_TOLERANCE = 1e-8

export function compareNumericResult(actual: NumericResult, expected: NumericResult): string[] {
  const failures: string[] = []
  if (actual.rowsUsed !== expected.rowsUsed) failures.push("rowsUsed")
  if (Math.abs(actual.coefficient - expected.coefficient) > COEFFICIENT_ABS_TOLERANCE) {
    failures.push("coefficient")
  }
  if (Math.abs(actual.stdError - expected.stdError) > STANDARD_ERROR_ABS_TOLERANCE) {
    failures.push("stdError")
  }
  return failures
}
