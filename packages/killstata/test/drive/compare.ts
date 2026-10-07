import type { ScenarioRunReport } from "./runner"

export function driveOutcome(input: {
  assertions: ScenarioRunReport["assertions"]
  toolErrors: ScenarioRunReport["toolErrors"]
  unrecoveredErrors: ScenarioRunReport["toolErrors"]
  sessionErrors: readonly string[]
}) {
  const functionalPass = input.assertions.every((assertion) => assertion.pass) && input.sessionErrors.length === 0
  return {
    functionalPass,
    stabilityPass: input.toolErrors.length === 0 && input.sessionErrors.length === 0,
    // 已处理的错误包含设计内门禁与自动修复；原始调用仍保留在 toolErrors。
    recoveredErrors: input.toolErrors.filter((error) => !input.unrecoveredErrors.includes(error)),
    unrecoveredErrors: input.unrecoveredErrors,
  }
}

export type DriveMetricLayer = "contract" | "behavior" | "ux"

export type DriveAggregate = {
  total: number
  passed: number
  passRate: number
  stabilityPassed: number
  stabilityPassRate: number
  uxCoveredScenarios: number
  timedOut: number
  averageElapsedMs: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  byLayer: Record<DriveMetricLayer, { passed: number; total: number; passRate: number }>
}

export function assertionLayer(label: string, category?: "ux"): DriveMetricLayer {
  if (category === "ux") return "ux"
  if (/无工具错误|未超时|baseline_estimate|产出结果文件/.test(label)) return "contract"
  return "behavior"
}

export function aggregateDriveReports(reports: ScenarioRunReport[]): DriveAggregate {
  const layers: Record<DriveMetricLayer, { passed: number; total: number }> = {
    contract: { passed: 0, total: 0 },
    behavior: { passed: 0, total: 0 },
    ux: { passed: 0, total: 0 },
  }
  let elapsed = 0
  let totalTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  for (const report of reports) {
    elapsed += report.elapsedMs
    totalTokens += (report.usage?.inputTokens ?? 0) + (report.usage?.outputTokens ?? 0) + (report.usage?.reasoningTokens ?? 0)
    cacheReadTokens += report.usage?.cacheReadTokens ?? 0
    cacheWriteTokens += report.usage?.cacheWriteTokens ?? 0
    for (const assertion of report.assertions) {
      const layer = assertionLayer(assertion.label, assertion.category)
      layers[layer].total += 1
      if (assertion.pass) layers[layer].passed += 1
    }
  }
  const total = reports.length
  const passed = reports.filter((report) => report.pass).length
  const stabilityPassed = reports.filter((report) => report.stabilityPass === true).length
  const uxCoveredScenarios = reports.filter((report) => report.assertions.some((assertion) => assertion.category === "ux")).length
  const withRate = (layer: { passed: number; total: number }) => ({
    ...layer,
    passRate: layer.total === 0 ? 1 : layer.passed / layer.total,
  })
  return {
    total,
    passed,
    passRate: total === 0 ? 1 : passed / total,
    stabilityPassed,
    stabilityPassRate: total === 0 ? 1 : stabilityPassed / total,
    uxCoveredScenarios,
    timedOut: reports.filter((report) => report.timedOut).length,
    averageElapsedMs: total === 0 ? 0 : elapsed / total,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    byLayer: {
      contract: withRate(layers.contract),
      behavior: withRate(layers.behavior),
      ux: withRate(layers.ux),
    },
  }
}

export function compareDriveReports(baseline: ScenarioRunReport[], candidate: ScenarioRunReport[]) {
  const base = aggregateDriveReports(baseline)
  const next = aggregateDriveReports(candidate)
  return {
    baseline: base,
    candidate: next,
    delta: {
      passRate: next.passRate - base.passRate,
      averageElapsedMs: next.averageElapsedMs - base.averageElapsedMs,
      totalTokens: next.totalTokens - base.totalTokens,
      cacheReadTokens: next.cacheReadTokens - base.cacheReadTokens,
      cacheWriteTokens: next.cacheWriteTokens - base.cacheWriteTokens,
      byLayer: {
        contract: next.byLayer.contract.passRate - base.byLayer.contract.passRate,
        behavior: next.byLayer.behavior.passRate - base.byLayer.behavior.passRate,
        ux: next.byLayer.ux.passRate - base.byLayer.ux.passRate,
      },
    },
  }
}
