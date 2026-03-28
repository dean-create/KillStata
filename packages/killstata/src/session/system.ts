import { Ripgrep } from "../file/ripgrep"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"
import { Log } from "../util/log"

import { Instance } from "../project/instance"
import path from "path"
import os from "os"

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
1. Environment check:
   - When Python readiness is uncertain, call data_import with action="healthcheck" first.
2. Data intake:
   - If source data is xlsx/csv/dta/sav, call data_import with action="import" first.
   - Prefer the returned datasetId/stageId artifact reference over raw file paths after import.
   - Confirm the canonical working dataset before running any model.
   - Treat the canonical working dataset as a Parquet stage with metadata sidecars.
   - Treat CSV/XLSX as inspection/export artifacts and DTA as import/export only, not the primary working layer.
3. Data quality gate:
   - Call data_import with action="qa" before estimation on the working dataset.
   - Check missingness, duplicates, outliers, variable ranges, and panel identifiers.
   - Use data_import actions such as filter, preprocess, describe, or correlation before estimation when needed.
4. Identification setup:
   - Explicitly define outcome, treatment, covariates, entity identifier, time identifier, and clustering level.
   - Explain why the chosen design matches the user's causal question.
5. Estimation:
   - Use econometrics with explicit method and options.
   - For panel baseline regressions, prefer methodName="panel_fe_regression" with entityVar, timeVar, and clusterVar.
6. Validation loop:
   - Read the saved diagnostics and metadata files after estimation.
   - Read numeric_snapshot.json before reporting any coefficient, p-value, standard error, R-squared, N, descriptive statistic, or correlation.
   - If outputs are inconsistent, coefficients are missing, or QA reports warnings/blocking errors, revise only the failed stage and rerun.
   - When a tool fails, inspect the reflection log and retryStage metadata before making the next call.
7. Reproducibility:
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
- Before complex spreadsheet, DTA, or econometric tasks, load the most relevant skill with the skill tool.
- Prefer tabular-ingest, tabular-cleaning, and panel-data-qa for data preparation tasks.
- Prefer descriptive-analysis, causal-design-selector, and regression-reporting for econometric workflows.
- Save every intermediate dataset and audit file when cleaning data
- Intermediate datasets should be Parquet stages; inspection files should be CSV/XLSX
- Treat datasetId/stageId as the default reference once a canonical artifact exists
- Never skip QA before a causal model when entity/time identifiers exist
- Prefer explicit column names and explicit tool arguments over assumptions
`

const log = Log.create({ service: "system-prompt" })

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

  export async function environment() {
    const project = Instance.project
    const dataFiles = await scanDataFiles(Instance.directory)

    return [
      [
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        dataFiles.length > 0 ? `<data_files>\n  ${dataFiles.join("\n  ")}\n</data_files>` : "",
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
