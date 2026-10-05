import fs from "fs"
import path from "path"
import { MessageV2 } from "@/session/message-v2"
import { prepareToolMetadata, summarizeToolError } from "@/runtime/tool-result-policy"
import { RuntimeTaskLedger } from "@/runtime/task-ledger"
import { TraceLogger } from "@/runtime/trace-logger"
import { workflowStatusSummary } from "@/runtime/workflow"
import type { DriveScenario } from "./scenarios"
import type { ScenarioRunReport } from "./runner"

const MAX_DIAGNOSTIC_FILE_BYTES = 256 * 1024
const MAX_DIAGNOSTIC_RUNS = 10
const MAX_DIAGNOSTIC_TOTAL_BYTES = 128 * 1024 * 1024
const CONVERSATION_TAIL_MESSAGES = 12
const CONVERSATION_PART_LIMIT = 12
const CONVERSATION_TEXT_BYTES = 4 * 1024

function safeText(value: unknown, maxBytes = CONVERSATION_TEXT_BYTES): string {
  return summarizeToolError(value, maxBytes)
}

function safeRecord(value: unknown, maxBytes = 32 * 1024): Record<string, unknown> {
  const prepared = prepareToolMetadata(value, maxBytes)
  return prepared
}

function writeBoundedJson(file: string, value: unknown): void {
  let serialized: string
  try {
    serialized = JSON.stringify(value, null, 2) ?? "null"
  } catch (error) {
    serialized = JSON.stringify({
      truncated: true,
      error: safeText(error),
      summary: "诊断数据无法序列化。",
    }, null, 2)
  }

  if (Buffer.byteLength(serialized, "utf8") > MAX_DIAGNOSTIC_FILE_BYTES) {
    serialized = JSON.stringify({
      truncated: true,
      summary: safeText(serialized, MAX_DIAGNOSTIC_FILE_BYTES / 2),
    }, null, 2)
  }
  fs.writeFileSync(file, `${serialized}\n`, { encoding: "utf8", mode: 0o600 })
}

function writeBoundedJsonl(file: string, records: unknown[]): void {
  const lines: string[] = []
  let bytes = 0
  for (const record of records) {
    let line: string
    try {
      line = JSON.stringify(record) ?? "null"
    } catch (error) {
      line = JSON.stringify({ _serializationError: safeText(error) })
    }
    const nextBytes = Buffer.byteLength(`${line}\n`, "utf8")
    if (bytes + nextBytes > MAX_DIAGNOSTIC_FILE_BYTES) {
      lines.push(JSON.stringify({
        _truncated: true,
        omittedRecords: records.length - lines.length,
      }))
      break
    }
    lines.push(line)
    bytes += nextBytes
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 })
}

function reportSummary(report: ScenarioRunReport | undefined): Record<string, unknown> | undefined {
  if (!report) return undefined
  return {
    scenarioID: report.scenarioID,
    scenarioLabel: report.scenarioLabel,
    pass: report.pass,
    timedOut: report.timedOut,
    questionCount: report.questionCount,
    questionEvents: report.questionEvents.map((event) => ({
      prompt: safeText(event.prompt),
      options: event.options.map((option) => safeText(option, 1_024)),
    })),
    toolErrors: report.toolErrors.map((error) => ({
      tool: error.tool,
      error: safeText(error.error),
      reflection: error.reflection,
    })),
    sessionErrors: report.sessionErrors ?? [],
    toolCalls: report.toolCalls,
    activeStage: report.activeStage,
    stageChain: report.stageChain,
    latestFailure: report.latestFailure
      ? { ...report.latestFailure, message: safeText(report.latestFailure.message) }
      : undefined,
    resultFiles: report.resultFiles,
    assertions: report.assertions,
    elapsedMs: report.elapsedMs,
    assistantTail: safeText(report.assistantTail, 12 * 1024),
  }
}

async function conversationTail(sessionID: string): Promise<unknown[]> {
  const newest: unknown[] = []
  try {
    for await (const message of MessageV2.stream(sessionID)) {
      const parts = message.parts.slice(-CONVERSATION_PART_LIMIT).map((part) => {
        if (part.type === "text") {
          return {
            type: part.type,
            text: safeText(part.text),
          }
        }
        if (part.type === "tool") {
          const state = part.state
          return {
            type: part.type,
            tool: part.tool,
            callID: part.callID,
            status: state.status,
            input: safeRecord(state.input, 8 * 1024),
            ...(state.status === "completed" ? { output: safeText(state.output, 8 * 1024) } : {}),
            ...(state.status === "error" ? { error: safeText(state.error) } : {}),
          }
        }
        if (part.type === "file") {
          return { type: part.type, filename: safeText(part.filename, 1_024) }
        }
        return { type: part.type }
      })
      newest.push({
        id: message.info.id,
        role: message.info.role,
        parts,
      })
      if (newest.length >= CONVERSATION_TAIL_MESSAGES) break
    }
  } catch (error) {
    return [{ _readError: safeText(error) }]
  }
  return newest.reverse()
}

/** Write a bounded, redacted diagnostic package for one failed drive scenario. */
export async function writeDriveFailureDiagnostics(input: {
  outputDir: string
  scenario: DriveScenario
  sessionID?: string
  report?: ScenarioRunReport
  error?: unknown
}): Promise<string> {
  fs.mkdirSync(input.outputDir, { recursive: true, mode: 0o700 })

  const trace = input.sessionID ? TraceLogger.readSession(input.sessionID) : []
  let ledger: unknown = { unavailable: true }
  let workflow: unknown = { unavailable: true }
  if (input.sessionID) {
    try {
      ledger = RuntimeTaskLedger.listTasks(input.sessionID)
    } catch (error) {
      ledger = { unavailable: true, error: safeText(error) }
    }
    try {
      workflow = workflowStatusSummary(input.sessionID)
    } catch (error) {
      workflow = { unavailable: true, error: safeText(error) }
    }
  }

  writeBoundedJson(path.join(input.outputDir, "summary.json"), {
    schemaVersion: 1,
    kind: "killstata-drive-failure",
    scenario: {
      id: input.scenario.id,
      label: input.scenario.label,
      dataFile: input.scenario.dataFile,
    },
    sessionID: input.sessionID,
    error: input.error === undefined ? undefined : safeText(input.error),
    report: reportSummary(input.report),
  })
  writeBoundedJsonl(
    path.join(input.outputDir, "trace.jsonl"),
    trace.slice(-500).map((record) => safeRecord(record, 24 * 1024)),
  )
  writeBoundedJson(path.join(input.outputDir, "task-ledger.json"), safeRecord(ledger))
  writeBoundedJson(path.join(input.outputDir, "workflow.json"), safeRecord(workflow))
  writeBoundedJson(
    path.join(input.outputDir, "conversation-tail.json"),
    await conversationTail(input.sessionID ?? ""),
  )
  return input.outputDir
}

function directorySize(directory: string): number {
  let total = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) total += directorySize(target)
    else {
      try {
        total += fs.statSync(target).size
      } catch {
        // A concurrently removed artifact is already reclaimed.
      }
    }
  }
  return total
}

/** Keep diagnostic history bounded so repeated failed manual tests cannot fill the disk. */
export function pruneDriveDiagnostics(root: string): void {
  if (!fs.existsSync(root)) return
  const directories = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = path.join(root, entry.name)
      return { directory, mtime: fs.statSync(directory).mtimeMs }
    })
    .sort((left, right) => right.mtime - left.mtime)

  let total = 0
  for (const [index, item] of directories.entries()) {
    const size = directorySize(item.directory)
    if (index >= MAX_DIAGNOSTIC_RUNS || total + size > MAX_DIAGNOSTIC_TOTAL_BYTES) {
      fs.rmSync(item.directory, { recursive: true, force: true })
      continue
    }
    total += size
  }
}
