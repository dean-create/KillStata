import { Ripgrep } from "../file/ripgrep"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { Skill } from "../skill"

import { Instance } from "../project/instance"
import path from "path"
import os from "os"
import type { MessageV2 } from "./message-v2"
import { getStage, readDatasetManifest } from "../tool/analysis-state"
import { relativeWithinProject } from "../tool/analysis-path"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_ANTHROPIC_SPOOF from "./prompt/anthropic_spoof.txt"

import PROMPT_CODEX from "./prompt/codex_header.txt"
import type { Provider } from "@/provider/provider"
import { Flag } from "@/flag/flag"
import type { Agent } from "@/agent/agent"

const ECONOMETRICS_CONTEXT = `
# Econometric Analysis Context

You are operating as an econometric analysis assistant. When working with data:

## Data Awareness Priority
- Always scan the working directory for data files (csv, xlsx, dta, sav, parquet) before analysis
- Summarize dataset structure: rows, columns, variable types, missing values
- Identify potential panel structure (unit ID + time variables)
- Check for treatment/outcome variables based on naming conventions

## Mandatory Workflow
1. Plan first:
   - For non-trivial cleaning, causal inference, or multi-step spreadsheet work, first state a concise stage plan before calling tools.
   - The default stage order is: plan -> healthcheck/import -> preprocess/qa -> baseline estimate -> diagnostics -> robustness -> grounded narrative.
   - Name the current stage explicitly when retrying after a failure; do not restart the entire workflow if only one stage failed.
2. Environment check:
   - When Python readiness is uncertain, call data_import with action="healthcheck" first.
3. Data intake:
   - If source data is xlsx/csv/dta/sav, call data_import with action="import" first.
   - Prefer the returned datasetId/stageId artifact reference over raw file paths after import.
   - Confirm the canonical working dataset before running any model.
   - Treat the canonical working dataset as a Parquet stage with metadata sidecars.
   - Treat CSV/XLSX as inspection/export artifacts and DTA as import/export only, not the primary working layer.
4. Data quality gate:
   - Call data_import with action="qa" before estimation on the working dataset.
   - Check missingness, duplicates, outliers, variable ranges, and panel identifiers.
   - Use data_import actions such as filter, preprocess, describe, or correlation before estimation when needed.
   - If QA returns blocking errors, stop and repair only the QA/clean stage.
5. Identification setup:
   - Explicitly define outcome, treatment, covariates, entity identifier, time identifier, and clustering level.
   - Explain why the chosen design matches the user's causal question.
6. Estimation:
   - Use econometrics with explicit method and options.
   - For panel baseline regressions, prefer methodName="panel_fe_regression" with entityVar, timeVar, and clusterVar.
7. Diagnostics and robustness:
   - After a baseline model, read diagnostics.json before reporting conclusions.
   - Run core diagnostics first, then decide whether robustness checks are required.
   - If diagnostics expose blocking issues, repair only the failed stage and rerun from there.
8. Validation loop:
   - Read the saved diagnostics and metadata files after estimation.
   - Read numeric_snapshot.json before reporting any coefficient, p-value, standard error, R-squared, N, descriptive statistic, or correlation.
   - Verify that expected artifacts exist after each tool step before proceeding.
   - If outputs are inconsistent, coefficients are missing, or QA/diagnostics/reflection report blocking errors, revise only the failed stage and rerun.
   - Warnings may continue, but they must be surfaced explicitly in the final narrative.
   - When a tool fails, inspect the reflection log and retryStage metadata before making the next call.
   - Never report a statistical conclusion when the relevant numeric snapshot or diagnostics artifact is missing.
9. Reproducibility:
   - Save outputs under analysis/<method>/ or analysis/datasets/<datasetId>/ and report file paths clearly.

## Method Selection Protocol
When user describes a research question, determine the appropriate method:
- Descriptive goal -> Summary statistics, correlation, visualization
- Causal inference with treatment timing -> DID (check parallel trends)
- Assignment variable with cutoff -> RDD
- Valid instrument available -> IV/2SLS
- Selection on observables -> PSM/IPW
- Panel baseline regression -> panel_fe_regression
- Otherwise -> OLS with robust or clustered standard errors

## Academic Standards
- Report statistical numbers only when they come from numeric_snapshot.json or a tool-provided numeric snapshot.
- Never invent, round, infer, or flip any coefficient, p-value, standard error, R-squared, N, descriptive statistic, or correlation.
- If no numeric snapshot is available, explicitly refuse to report statistical numbers and ask to read the snapshot or rerun the tool.
- Report coefficients with significance levels (*, **, ***) only when those values are grounded in the numeric snapshot.
- Include standard errors (robust or clustered)
- Run diagnostic tests: heteroskedasticity, multicollinearity, panel integrity
- Discuss effect sizes and economic significance
- State assumptions and limitations

## Tool Integration
- Use the econometrics tool for method-specific analysis
- Use the data_import tool for data preprocessing and QA
- If MCP tools named stata_run_selection, stata_run_file, or stata_session are available, use them instead of shell commands for Stata work.
- Prefer stata_run_selection for short interactive Stata snippets.
- Prefer stata_run_file for longer or reusable Stata workflows, and use absolute paths.
- Keep and reuse session_id for multi-step Stata work so the dataset state persists between calls.
- Before complex spreadsheet, DTA, or econometric tasks, load the most relevant skill with the skill tool.
- Skill aliases:
  - Excel/XLSX processing -> prefer xlsx or the closest spreadsheet-processing skill available
  - CSV summarization -> prefer CSV Data Summarizer or the closest csv/tabular profiling skill available
  - Missing-data handling and variable engineering -> prefer a matching imported skill when available, otherwise fall back to data_import
  - Diagnostic testing and robustness -> prefer a matching imported skill when available, otherwise fall back to econometrics diagnostics
- Prefer the closest installed skill rather than hallucinating an unavailable skill name.
- Save every intermediate dataset and audit file when cleaning data
- Intermediate datasets should be Parquet stages; inspection files should be CSV/XLSX
- Treat datasetId/stageId as the default reference once a canonical artifact exists
- Never skip QA before a causal model when entity/time identifiers exist
- Prefer explicit column names and explicit tool arguments over assumptions
`

const log = Log.create({ service: "system-prompt" })

const SKILL_ALIAS_CANDIDATES = [
  { capability: "xlsx_excel_processing", labels: ["xlsx"], preferred: ["xlsx"] },
  { capability: "csv_summarization", labels: ["csv summarization"], preferred: ["csv-data-summarizer", "CSV Data Summarizer"] },
  { capability: "missing_data_handling", labels: ["missing-data handling"], preferred: ["missing-data-handler"] },
  { capability: "variable_engineering", labels: ["variable engineering"], preferred: ["variable-engineering"] },
  { capability: "diagnostic_testing", labels: ["diagnostic testing"], preferred: ["diagnostic-testing"] },
  { capability: "robustness_checks", labels: ["robustness checks"], preferred: ["robustness-check"] },
] as const

function findInstalledSkillMatch(
  skills: Awaited<ReturnType<typeof Skill.all>>,
  preferred: readonly string[],
) {
  const lowered = skills.map((skill) => ({ ...skill, lower: skill.name.toLowerCase() }))
  for (const candidate of preferred) {
    const exact = lowered.find((skill) => skill.lower === candidate.toLowerCase())
    if (exact) return exact
  }
  for (const candidate of preferred) {
    const fuzzy = lowered.find((skill) => skill.lower.includes(candidate.toLowerCase()))
    if (fuzzy) return fuzzy
  }
  return undefined
}

async function buildSkillAliasSummary() {
  const skills = await Skill.all().catch(() => [])
  if (skills.length === 0) return ""
  const lines = ["<skill_aliases>"]
  for (const alias of SKILL_ALIAS_CANDIDATES) {
    const match = findInstalledSkillMatch(skills, alias.preferred)
    lines.push(
      `  ${alias.capability}: ${match ? `${match.name} [${match.source}]` : "unavailable; fall back to data_import/econometrics"}`,
    )
  }
  lines.push("</skill_aliases>")
  return lines.join("\n")
}

async function resolveRelativeInstruction(instruction: string): Promise<string[]> {
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    return Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])
  }
  if (!Flag.OPENCODE_CONFIG_DIR) {
    log.warn(
      `Skipping relative instruction "${instruction}" - no OPENCODE_CONFIG_DIR set while project config is disabled`,
    )
    return []
  }
  return Filesystem.globUp(instruction, Flag.OPENCODE_CONFIG_DIR, Flag.OPENCODE_CONFIG_DIR).catch(() => [])
}

export namespace SystemPrompt {
  export function agent(agent: Agent.Info) {
    if (agent.name === "analyst") {
      return [
        [
          "# Analyst Workflow",
          "- You are the primary econometric analysis agent.",
          "- Before starting a new econometric workflow, ask the user whether they want a concise plan first.",
          "- Use the question tool to ask this once at the start of the workflow.",
          "- If the user wants a plan, present a concise step-by-step analysis plan before executing tools.",
          "- After presenting the plan, execute the econometric workflow according to that plan.",
          "- Before non-trivial econometric analysis, load the most relevant built-in skill with the skill tool.",
          "- Prefer causal-design-selector, descriptive-analysis, and regression-reporting when the task matches them.",
        ].join("\n"),
      ]
    }

    if (agent.name === "explorer") {
      return [
        [
          "# Explorer Workflow",
          "- You are the exploratory data-processing agent.",
          "- Before any row deletion, filter removal, dropna, or other deletion-like data operation, ask the user to confirm.",
          "- Use the question tool before destructive data cleaning steps.",
          "- If the user declines, stop the destructive action and preserve the current dataset.",
          "- Before spreadsheet, CSV, Excel, or DTA processing, load the most relevant built-in skill with the skill tool.",
          "- Prefer tabular-ingest, tabular-cleaning, and panel-data-qa when the task matches them.",
        ].join("\n"),
      ]
    }

    return []
  }

  export function header(providerID: string) {
    if (providerID.includes("anthropic")) return [PROMPT_ANTHROPIC_SPOOF.trim()]
    return []
  }

  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export function provider(model: Provider.Model) {
    let basePrompt: string
    if (model.api.id.includes("gpt-5")) {
      basePrompt = PROMPT_CODEX
    } else if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3")) {
      basePrompt = PROMPT_BEAST
    } else if (model.api.id.includes("gemini-")) {
      basePrompt = PROMPT_GEMINI
    } else if (model.api.id.includes("claude")) {
      basePrompt = PROMPT_ANTHROPIC
    } else {
      basePrompt = PROMPT_ANTHROPIC_WITHOUT_TODO
    }

    return [basePrompt, ECONOMETRICS_CONTEXT]
  }

  export async function environment(input?: { messages?: MessageV2.WithParts[] }) {
    const project = Instance.project
    const dataSummary = await buildDataSummary(input?.messages)
    const skillSummary = await buildSkillAliasSummary()

    return [
      [
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        dataSummary,
        skillSummary,
        `<files>`,
        `  ${project.vcs === "git" && false
          ? await Ripgrep.tree({
            cwd: Instance.directory,
            limit: 200,
          })
          : ""
        }`,
        `</files>`,
      ].filter(Boolean).join("\n"),
    ]
  }

  async function scanDataFiles(directory: string): Promise<string[]> {
    const dataExtensions = ["csv", "xlsx", "xls", "dta", "sav", "parquet"]
    const results: string[] = []

    try {
      for (const ext of dataExtensions) {
        const glob = new Bun.Glob(`**/*.${ext}`)
        const matches = await Array.fromAsync(
          glob.scan({
            cwd: directory,
            absolute: false,
            onlyFiles: true,
          }),
        ).catch(() => [])
        results.push(...matches.slice(0, 5))
      }
    } catch {
      return results
    }

    return results.slice(0, 20)
  }

  function currentDatasetContext(messages: MessageV2.WithParts[] = []) {
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex]
      if (message.info.role !== "assistant") continue
      for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
        const part = message.parts[partIndex]
        if (part.type !== "tool" || part.state.status !== "completed") continue
        const metadata = (part.state.metadata ?? {}) as Record<string, unknown>
        const result = (metadata.result ?? {}) as Record<string, unknown>
        const datasetId =
          (typeof metadata.datasetId === "string" ? metadata.datasetId : undefined) ??
          (typeof result.dataset_id === "string" ? result.dataset_id : undefined)
        if (!datasetId) continue
        const stageId =
          (typeof metadata.stageId === "string" ? metadata.stageId : undefined) ??
          (typeof result.stage_id === "string" ? result.stage_id : undefined)
        const runId =
          (typeof metadata.runId === "string" ? metadata.runId : undefined) ??
          (typeof result.run_id === "string" ? result.run_id : undefined)
        return { datasetId, stageId, runId }
      }
    }
    return undefined
  }

  async function buildDataSummary(messages?: MessageV2.WithParts[]) {
    const current = currentDatasetContext(messages)
    if (current?.datasetId) {
      try {
        const manifest = readDatasetManifest(current.datasetId)
        const stage = getStage(manifest, current.stageId)
        const rows = stage.rowCount !== undefined ? `${stage.rowCount} rows` : "rows unknown"
        const columns = stage.columnCount !== undefined ? `${stage.columnCount} columns` : "columns unknown"
        return [
          "<data_summary>",
          `  Current canonical dataset: ${manifest.datasetId}`,
          `  Source file: ${relativeWithinProject(manifest.sourcePath)}`,
          `  Current stage: ${stage.stageId} (${stage.action}, branch=${stage.branch})`,
          `  Working parquet: ${relativeWithinProject(stage.workingPath)}`,
          `  Shape: ${rows}, ${columns}`,
          current.runId ? `  Current run: ${current.runId}` : "",
          "</data_summary>",
        ]
          .filter(Boolean)
          .join("\n")
      } catch {}
    }

    const dataFiles = await scanDataFiles(Instance.directory)
    if (dataFiles.length === 0) return ""
    const counts = dataFiles.reduce<Record<string, number>>((acc, item) => {
      const ext = path.extname(item).replace(/^\./, "").toLowerCase() || "unknown"
      acc[ext] = (acc[ext] ?? 0) + 1
      return acc
    }, {})
    const candidates = [...dataFiles]
      .sort((a, b) => {
        const depthDiff = a.split(/[\\/]+/).length - b.split(/[\\/]+/).length
        if (depthDiff !== 0) return depthDiff
        return a.length - b.length
      })
      .slice(0, 3)
    return [
      "<data_summary>",
      `  Candidate source files: ${dataFiles.length}`,
      `  By extension: ${Object.entries(counts)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([ext, count]) => `${ext}=${count}`)
        .join(", ")}`,
      `  Top candidates: ${candidates.join(", ")}`,
      "</data_summary>",
    ].join("\n")
  }

  const LOCAL_RULE_FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]
  const GLOBAL_RULE_FILES = [path.join(Global.Path.config, "AGENTS.md")]
  if (!Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT) {
    GLOBAL_RULE_FILES.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
  }

  if (Flag.OPENCODE_CONFIG_DIR) {
    GLOBAL_RULE_FILES.push(path.join(Flag.OPENCODE_CONFIG_DIR, "AGENTS.md"))
  }

  export async function custom() {
    const config = await Config.get()
    const paths = new Set<string>()

    if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
      for (const localRuleFile of LOCAL_RULE_FILES) {
        const matches = await Filesystem.findUp(localRuleFile, Instance.directory, Instance.worktree)
        if (matches.length > 0) {
          matches.forEach((item) => paths.add(item))
          break
        }
      }
    }

    for (const globalRuleFile of GLOBAL_RULE_FILES) {
      if (await Bun.file(globalRuleFile).exists()) {
        paths.add(globalRuleFile)
        break
      }
    }

    const urls: string[] = []
    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) {
          urls.push(instruction)
          continue
        }
        if (instruction.startsWith("~/")) {
          instruction = path.join(os.homedir(), instruction.slice(2))
        }
        let matches: string[] = []
        if (path.isAbsolute(instruction)) {
          matches = await Array.fromAsync(
            new Bun.Glob(path.basename(instruction)).scan({
              cwd: path.dirname(instruction),
              absolute: true,
              onlyFiles: true,
            }),
          ).catch(() => [])
        } else {
          matches = await resolveRelativeInstruction(instruction)
        }
        matches.forEach((item) => paths.add(item))
      }
    }

    const foundFiles = Array.from(paths).map((item) =>
      Bun.file(item)
        .text()
        .catch(() => "")
        .then((text) => "Instructions from: " + item + "\n" + text),
    )
    const foundUrls = urls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "")
        .then((text) => (text ? "Instructions from: " + url + "\n" + text : "")),
    )
    return Promise.all([...foundFiles, ...foundUrls]).then((result) => result.filter(Boolean))
  }
}
