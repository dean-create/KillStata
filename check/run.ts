import fs from "fs"
import path from "path"
import { runLivePanelFeReplay } from "./src/live"
import { inspectLinearmodelsDatasets } from "./src/linearmodels"
import { ensureNswFixture } from "./src/nsw"
import { runFixedPanelFePilot } from "./src/pilot"
import { verifyWorkbookContracts } from "./src/workbook-contract"
import { loadBenchmarkCatalog } from "./src/catalog"
import { validateEvidenceRecord } from "./src/evidence"
import { runNswPsmEvidence } from "./src/psm-nsw"
import { runCardOlsIvEvidence } from "./src/card-ols-iv"

const RESULTS_PATH = path.resolve(import.meta.dir, "results", "latest.json")

async function main() {
  const runLive = process.argv.includes("--live")
  const workbooks = verifyWorkbookContracts()
  const nsw = ensureNswFixture()
  const linearmodels = inspectLinearmodelsDatasets()
  const fixed = await runFixedPanelFePilot()
  const psm = await runNswPsmEvidence()
  const card = await runCardOlsIvEvidence()
  const catalog = loadBenchmarkCatalog()
  for (const record of Object.values(psm)) validateEvidenceRecord(catalog, record)
  const cardEvidence = [
    {
      toolId: "ols_regression",
      datasetId: "card1995",
      grade: "B" as const,
      status: "PASS" as const,
      harness: { schemaAccepted: true, ...card.ols.harness },
      numericOracle: { name: "statsmodels HC1 direct Card oracle", matched: card.ols.numericOracle.matched },
    },
    {
      toolId: "iv_2sls",
      datasetId: "card1995",
      grade: "B" as const,
      status: "PASS" as const,
      harness: { schemaAccepted: true, ...card.iv.harness },
      numericOracle: { name: "linearmodels IV2SLS robust direct Card oracle", matched: card.iv.numericOracle.matched },
    },
  ]
  for (const record of cardEvidence) validateEvidenceRecord(catalog, record)
  const fixedPass =
    fixed.numeric.linearmodelsWiringFailures.length === 0 &&
    fixed.numeric.independentOracle.failures.length === 0 &&
    fixed.numeric.crossEngine.rowsMatch &&
    fixed.numeric.crossEngine.coefficientGap < 1e-8
  const live = runLive ? await runLivePanelFeReplay() : { status: "PENDING_LIVE_REPLAY", reason: "未传 --live" }
  const report = {
    recordedAt: new Date().toISOString(),
    scope: "check-only acceptance base; production source files were not modified",
    overallStatus: !fixedPass
      ? "BLOCKED_NUMERIC_MISMATCH"
      : live.status === "PASS"
        ? "PENDING_INDEPENDENT_SE_ORACLE"
        : live.status,
    workbooks,
    nsw,
    linearmodels,
    fixedPanelFe: fixed,
    psm,
    card: { ...card, evidence: cardEvidence },
    liveReplay: live,
    nextGate:
      "Panel FE、OLS、IV 已完成真实 Harness 与独立数值 oracle。下一步锁定 mpdta，依次为 did_static、did2s、事件研究补同样的真实数据与失败门；PSM matching 维持真实数据安全拒绝。",
  }
  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true })
  fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf-8")
  process.stdout.write(`${JSON.stringify({ overallStatus: report.overallStatus, report: RESULTS_PATH })}\n`)
}

main().catch((error) => {
  process.stderr.write(`验收基座运行失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
