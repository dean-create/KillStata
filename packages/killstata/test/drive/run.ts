/**
 * drive harness CLI：真实数据自动化验证矩阵入口。
 *
 * 用法（packages/killstata 目录下）：
 *   bun run test:drive                     # 全矩阵（所有场景，真实模型，顺序执行）
 *   bun run test:drive --only did-direct   # 只跑某个场景（修复后快速验证）
 *   bun run test:drive --runs 2            # 每场景连跑 N 轮验证稳定性
 *   bun run test:drive --model custom/deepseek-v4-flash --variant medium --timeout 300000
 *   bun run test:drive --question-indexes 1,0  # 多轮问题依次选择第二项、第一项
 *   # 不传 --model 时跟随当前配置的 provider/model；裸 id 也跟随该 provider
 *   bun run test:drive --scan              # 只跑反模式静态扫描（不调模型）
 *   bun run test:drive --check             # 只做场景定义静态校验（不调模型，秒级）
 *
 * 输出：控制台表格（人类可读）+ test/sandbox/drive-report/<ts>/summary.json（机器可读）。
 * 退出码：任一场景 fail 返回 1；全过返回 0；--scan 命中返回 1；--check 有错返回 1。
 */
import fs from "fs"
import path from "path"
import { DRIVE_SCENARIOS, findScenario, validateScenarios } from "./scenarios"
import { runScenario } from "./runner"
import { scanAntiPatterns, summarizeAntiPatterns } from "./anti-patterns"
import type { ScenarioRunReport } from "./runner"
import { aggregateDriveReports } from "./compare"
import { parseQuestionOptionIndexes } from "./options"

function flag(name: string, fallback: string | number): string | number {
  const index = process.argv.indexOf(name)
  if (index === -1 || !process.argv[index + 1]) return fallback
  const value = process.argv[index + 1]
  if (typeof fallback === "number") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return value
}

function onlyScenarioIDs(): string[] {
  const only = process.argv.indexOf("--only")
  if (only === -1) return []
  // 支持 --only a,b 或 --only a
  return process.argv[only + 1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? []
}

async function main() {
  const onlyIDs = onlyScenarioIDs()
  const runs = Number(flag("--runs", 1))
  const modelArg = flag("--model", "")
  const modelID = typeof modelArg === "string" && modelArg.trim() ? modelArg.trim() : undefined
  const variantArg = flag("--variant", "medium")
  const variant = typeof variantArg === "string" && variantArg.trim() ? variantArg.trim() : "medium"
  const timeoutMs = Number(flag("--timeout", 5 * 60_000))
  const questionOptionIndexes = parseQuestionOptionIndexes(String(flag("--question-indexes", "")))
  const scanOnly = process.argv.includes("--scan")

  // --check：场景定义静态校验（不调模型，秒级）——文件存在/消息定义防呆，
  // 避免"跑 5 分钟才发现数据文件名拼错"的白跑（2026-08-11 额度优化：静态优先）
  if (process.argv.includes("--check")) {
    const problems = validateScenarios(DRIVE_SCENARIOS)
    if (problems.length === 0) {
      console.log(`[drive-check] ${DRIVE_SCENARIOS.length} 个场景定义全部有效 ✅`)
      process.exit(0)
    }
    for (const p of problems) console.log(`❌ ${p.id}: ${p.problem}`)
    console.log(`[drive-check] ${problems.length} 个问题`)
    process.exit(1)
  }

  // --scan：静态反模式扫描（不调模型，几秒完成）
  if (scanOnly) {
    const hits = scanAntiPatterns()
    console.log(summarizeAntiPatterns(hits))
    process.exit(hits.length > 0 ? 1 : 0)
  }

  const scenarios = onlyIDs.length > 0
    ? onlyIDs.map((id) => findScenario(id)).filter((s): s is NonNullable<typeof s> => s !== undefined)
    : DRIVE_SCENARIOS
  if (scenarios.length === 0) {
    console.error(`没有匹配的场景：--only ${onlyIDs.join(",")}。可用：${DRIVE_SCENARIOS.map((s) => s.id).join(", ")}`)
    process.exit(2)
  }

  console.log(`[drive] matrix=${scenarios.map((s) => s.id).join(",")} runs=${runs} model=${modelID ?? "configured-default"} variant=${variant} timeout=${timeoutMs}ms`)
  const allReports: ScenarioRunReport[] = []
  const started = Date.now()

  for (const scenario of scenarios) {
    for (let run = 1; run <= runs; run++) {
      const label = runs > 1 ? `${scenario.label} (run ${run}/${runs})` : scenario.label
      const report = await runScenario(scenario, {
        modelID,
        variant,
        timeoutMs,
        questionOptionIndexes,
        diagnosticsKey: `${scenario.id}-run-${run}`,
      })
      allReports.push(report)
      const icon = report.pass ? "✅" : "❌"
      const failed = report.assertions.filter((a) => !a.pass)
      console.log(`${icon} ${label} [${(report.elapsedMs / 1000).toFixed(1)}s] question=${report.questionCount} stage=${report.activeStage ?? "-"}`)
      for (const a of failed) {
        console.log(`    ✗ ${a.label}: ${a.detail.slice(0, 200)}`)
      }
      if (report.diagnosticsDir) console.log(`    诊断包：${report.diagnosticsDir}`)
    }
  }

  // 汇总表
  const total = allReports.length
  const passed = allReports.filter((r) => r.pass).length
  const aggregate = aggregateDriveReports(allReports)
  const elapsed = ((Date.now() - started) / 1000).toFixed(0)
  console.log(`\n===== drive 功能完成：${passed}/${total}（${elapsed}s）=====`)
  console.log(`零错误稳定性=${aggregate.stabilityPassed}/${total} UX场景覆盖=${aggregate.uxCoveredScenarios}/${total}`)
  console.log(`契约=${(aggregate.byLayer.contract.passRate * 100).toFixed(1)}% 行为=${(aggregate.byLayer.behavior.passRate * 100).toFixed(1)}% UX断言=${(aggregate.byLayer.ux.passRate * 100).toFixed(1)}%`)
  console.log(`tokens=${aggregate.totalTokens} cacheRead=${aggregate.cacheReadTokens} cacheWrite=${aggregate.cacheWriteTokens} timeout=${aggregate.timedOut}`)

  // UX 维度单独统计（报告质量 / 进度提示 / 提问质量）。断言用 category="ux"
  // 标记（scenarios.ts），不靠 label 文案匹配（改名即静默失效）。
  const uxRows = allReports.filter((r) => r.assertions.some((a) => a.category === "ux"))
  if (uxRows.length > 0) {
    console.log(`\n── UX 交互体验（${uxRows.length} 个场景断言了 UX）──`)
    for (const r of uxRows) {
      const uxFailures = r.assertions.filter((a) => a.category === "ux" && !a.pass)
      const uxPasses = r.assertions.filter((a) => a.category === "ux" && a.pass)
      const mark = uxFailures.length === 0 ? "✅" : "❌"
      console.log(`${mark} ${r.scenarioID}: UX ${uxPasses.length}/${uxPasses.length + uxFailures.length}`)
      for (const a of uxFailures) console.log(`    ✗ ${a.label}: ${a.detail.slice(0, 200)}`)
    }
  }

  for (const r of allReports) {
    if (r.recoveredErrors?.length) console.log(`↳ ${r.scenarioID}: ${r.recoveredErrors.length} 次已处理工具波折（原始错误保留）`)
    if (r.pass) continue
    console.log(`❌ ${r.scenarioID}`)
    for (const e of r.toolErrors) console.log(`    toolError: ${e.tool} → ${e.error.slice(0, 160)}`)
    if (r.latestFailure) console.log(`    latestFailure: ${r.latestFailure.code ?? ""} ${r.latestFailure.message.slice(0, 160)}`)
    console.log(`    stageChain: ${r.stageChain.join(" → ") || "(无)"}`)
    if (r.diagnosticsDir) console.log(`    diagnostics: ${r.diagnosticsDir}`)
  }

  // 落盘报告
  const reportDir = path.join(process.cwd(), "test", "sandbox", "drive-report", new Date().toISOString().replace(/[:.]/g, "-"))
  fs.mkdirSync(reportDir, { recursive: true })
  fs.writeFileSync(
    path.join(reportDir, "summary.json"),
    JSON.stringify({ timestamp: new Date().toISOString(), passed, total, elapsedSec: elapsed, aggregate, scenarios: allReports }, null, 2),
  )
  console.log(`\n报告：${reportDir}/summary.json`)

  process.exit(passed === total ? 0 : 1)
}

main().catch((error) => {
  console.error("drive 崩溃：", error)
  process.exit(2)
})
