import fs from "fs"
import os from "os"
import path from "path"
import { describe, expect, test } from "bun:test"
import type { DriveScenario } from "./scenarios"
import type { ScenarioRunReport } from "./runner"
import { pruneDriveDiagnostics, writeDriveFailureDiagnostics } from "./diagnostics"

const scenario: DriveScenario = {
  id: "diagnostic-test",
  label: "diagnostic test",
  dataFile: null,
  expectEstimate: false,
  userMessage: () => "test",
  behavior: () => [],
}

function report(): ScenarioRunReport {
  return {
    scenarioID: scenario.id,
    scenarioLabel: scenario.label,
    pass: false,
    timedOut: true,
    questionCount: 0,
    questionEvents: [],
    toolErrors: [{ tool: "test", error: "api_key=sk-diagnostic-secret" }],
    toolCalls: [],
    activeStage: "baseline_estimate",
    stageChain: ["baseline_estimate=failed"],
    latestFailure: {
      code: "TEST_FAILURE",
      toolName: "test",
      retryStage: "estimate",
      message: "failed",
    },
    resultFiles: [],
    assertions: [],
    elapsedMs: 1,
    assistantTexts: [],
    turnTexts: [],
    lastTurnAssistantText: "",
    finalAssistantText: "",
    assistantTail: "api_key=sk-diagnostic-secret",
  }
}

describe("drive failure diagnostics", () => {
  test("writes bounded diagnostics and redacts secrets", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-drive-diagnostics-"))
    try {
      const output = await writeDriveFailureDiagnostics({
        outputDir: path.join(root, "one"),
        scenario,
        sessionID: "missing-session",
        report: report(),
        error: new Error(`api_key=sk-error-secret ${"x".repeat(500_000)}`),
      })
      const summary = fs.readFileSync(path.join(output, "summary.json"), "utf8")
      expect(summary).not.toContain("sk-error-secret")
      expect(summary).not.toContain("sk-diagnostic-secret")
      expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(256 * 1024)
      expect(fs.existsSync(path.join(output, "trace.jsonl"))).toBe(true)
      expect(fs.existsSync(path.join(output, "task-ledger.json"))).toBe(true)
      expect(fs.existsSync(path.join(output, "workflow.json"))).toBe(true)
      expect(fs.existsSync(path.join(output, "conversation-tail.json"))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("keeps only the newest ten diagnostic runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-drive-diagnostics-retain-"))
    try {
      for (let index = 0; index < 12; index += 1) {
        fs.mkdirSync(path.join(root, `run-${index}`), { recursive: true })
        fs.writeFileSync(path.join(root, `run-${index}`, "summary.json"), "{}")
        await Bun.sleep(1)
      }
      pruneDriveDiagnostics(root)
      expect(fs.readdirSync(root).sort()).toHaveLength(10)
      expect(fs.existsSync(path.join(root, "run-0"))).toBe(false)
      expect(fs.existsSync(path.join(root, "run-11"))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
