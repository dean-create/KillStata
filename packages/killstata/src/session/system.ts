import { Ripgrep } from "../file/ripgrep"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { formatSkillAliasXml, resolveSkillAliasAvailability } from "../skill"
import { userWorkspaceAgentsPath, userWorkspaceMemoryPath, userWorkspaceUserPath } from "../killstata/runtime-config"

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
   - If the user asks for a reasonable baseline, a standard baseline, or asks you to choose the baseline without naming a specific method, prefer econometrics with methodName="smart_baseline".
   - If the user only wants method selection advice without running a model, prefer econometrics with methodName="auto_recommend".
   - If the user explicitly names a method such as panel_fe_regression, ols_regression, did_static, iv_2sls, rdd_sharp, or psm_double_robust, respect that method unless it is not executable with the available identifiers or variables.
   - If an explicitly requested method is not executable, rescue the workflow by switching to methodName="smart_baseline" or the closest executable baseline, and disclose the original request, the failure reason, and the executed method.
   - For explicit panel baseline regressions, prefer methodName="panel_fe_regression" with entityVar, timeVar, and clusterVar.
7. Diagnostics and robustness:
   - After a baseline model, read diagnostics.json before reporting conclusions.
   - Run core diagnostics first, then decide whether robustness checks are required.
   - If diagnostics expose blocking issues, repair only the failed stage and rerun from there.
8. Validation loop:
   - Read the saved diagnostics and metadata files after estimation.
   - Prefer numeric_snapshot.json before reporting any coefficient, p-value, standard error, R-squared, N, descriptive statistic, or correlation.
   - If numeric_snapshot.json is unavailable, use explicitly read structured artifacts from the same turn such as diagnostics.json, coefficient tables, or summary/metadata JSON.
   - Verify that expected artifacts exist after each tool step before proceeding.
   - If outputs are inconsistent, coefficients are missing, or QA/diagnostics/reflection report blocking errors, revise only the failed stage and rerun.
   - Warnings may continue, but they must be surfaced explicitly in the final narrative.
   - When a tool fails, inspect the reflection log and retryStage metadata before making the next call.
   - Never report an unverified statistical number. If exact numbers cannot be grounded, continue with conservative qualitative analysis and state which statistics remain unverified.
9. Reproducibility:
   - Save outputs under analysis/<method>/ or analysis/datasets/<datasetId>/ and report file paths clearly.

## Method Selection Protocol
When user describes a research question, determine the appropriate method:
- Vague request for a standard or reasonable baseline without a named estimator -> smart_baseline
- Request to only inspect structure and recommend a method -> auto_recommend
- Descriptive goal -> Summary statistics, correlation, visualization
- Causal inference with treatment timing -> DID (check parallel trends)
- Assignment variable with cutoff -> RDD
- Valid instrument available -> IV/2SLS
- Selection on observables -> PSM/IPW
- Panel baseline regression -> panel_fe_regression
- Otherwise -> OLS with robust or clustered standard errors

## Academic Standards
- Report statistical numbers only when they come from numeric_snapshot.json, an explicitly read structured artifact in the same turn, or a tool-provided numeric snapshot.
- Never invent, round, infer, or flip any coefficient, p-value, standard error, R-squared, N, descriptive statistic, or correlation.
- If exact statistics cannot be grounded, omit the unsupported numbers, keep the discussion academically rigorous, and explain the missing verification briefly.
- Report coefficients with significance levels (*, **, ***) only when those values are grounded in trusted structured outputs.
- Include standard errors (robust or clustered)
- Run diagnostic tests: heteroskedasticity, multicollinearity, panel integrity
- Discuss effect sizes and economic significance
- State assumptions and limitations

## Tool Integration
- Use the econometrics tool for method-specific analysis
- Use 'research_brief' before estimation when the user is still shaping the topic, theory, design alternatives, or data plan.
- Prefer econometrics methodName="smart_baseline" for vague baseline-regression requests that do not specify a concrete estimator.
- Prefer econometrics methodName="auto_recommend" when the user asks for recommendation only and does not want execution yet.
- When the user explicitly requests a named estimator, keep that estimator unless it is not executable; if you rescue to another baseline, explain the change explicitly.
- Use 'heterogeneity_runner' only after a baseline result exists and only when subgroup or mechanism variables are explicit.
- Use 'paper_draft' and 'slide_generator' only from saved structured artifacts; never report unsupported numbers from memory in those stages.
- Use the data_import tool for data preprocessing and QA
- If MCP tools named stata_run_selection, stata_run_file, or stata_session are available, use them instead of shell commands for Stata work.
- Prefer stata_run_selection for short interactive Stata snippets.
- Prefer stata_run_file for longer or reusable Stata workflows, and use absolute paths.
- Keep and reuse session_id for multi-step Stata work so the dataset state persists between calls.
- Before complex spreadsheet, DTA, or econometric tasks, load workflow-orchestrator first with the skill tool, then load the most relevant specialist skill.
- Skill aliases:
  - Excel/XLSX processing -> prefer xlsx-processor, then tabular-ingest
  - CSV summarization -> prefer descriptive-analysis or the closest csv/tabular profiling skill available
  - Missing-data handling and variable engineering -> prefer tabular-cleaning, otherwise fall back to data_import
  - Panel structure checks -> prefer panel-data-qa before estimation
  - Idea formation and pre-analysis scoping -> prefer research-briefing
  - DID / IV / PSM / RDD -> prefer did-estimation / iv-estimation / psm-estimation / rdd-estimation when the design is already known
  - Diagnostic testing and robustness -> prefer robustness-check and regression-reporting, otherwise fall back to econometrics diagnostics
  - Post-baseline heterogeneity or mechanism work -> prefer heterogeneity-analysis
  - Paper drafting -> prefer paper-drafting
  - Academic seminar deck generation -> prefer slide-generator
- Prefer default skills first, then fall back to builtin skills with the same name.
- Save every intermediate dataset and audit file when cleaning data
- Intermediate datasets should be Parquet stages; inspection files should be CSV/XLSX
- Treat datasetId/stageId as the default reference once a canonical artifact exists
- Never skip QA before a causal model when entity/time identifiers exist
- Prefer explicit column names and explicit tool arguments over assumptions

## Strategic Task Planning
- 褰撴敹鍒板鏉備换鍔℃椂锛屾寜浠ヤ笅闃舵鍒嗚В鎵ц锛?- 1. 鐞嗚В闃舵锛氭壂鎻忔暟鎹枃浠讹紝璇嗗埆鍙橀噺瑙掕壊锛堝洜鍙橀噺/鑷彉閲?鎺у埗鍙橀噺/ID/鏃堕棿锛?- 2. 鍑嗗闃舵锛歩mport -> qa -> 蹇呰鐨?filter/preprocess
- 3. 璁惧畾闃舵锛氱‘瀹氳瘑鍒瓥鐣ワ紝璇存槑鍏抽敭鍋囪
- 4. 浼拌闃舵锛氳皟鐢?econometrics 宸ュ叿
- 5. 楠岃瘉闃舵锛氳鍙?diagnostics.json锛屾鏌ユ墍鏈夎瘖鏂寚鏍?- 6. 鎶ュ憡闃舵锛氱敓鎴愪笁绾胯〃锛屽啓鍑鸿В璇?- 姣忎釜闃舵蹇呴』瀹屾垚鎵嶈兘杩涘叆涓嬩竴闃舵銆傚鏋滀换浣曢樁娈靛け璐ワ紝鍙洖閫€鍒拌闃舵閲嶈瘯銆?
## Iterative Validation Loop
- 浼拌瀹屾垚鍚庡繀椤昏繘鍏ラ獙璇佺幆锛?- 1. 璇诲彇 diagnostics.json 鍜?numeric_snapshot.json
- 2. 妫€鏌ュ紓鏂瑰樊妫€楠岋紱濡傛灉鏄捐憲锛屽缓璁娇鐢ㄧǔ鍋ユ垨鑱氱被鏍囧噯璇?- 3. 妫€鏌?VIF锛涘鏋滃ぇ浜?10锛岃鍛婂閲嶅叡绾挎€?- 4. 妫€鏌ヨ仛绫绘暟锛涘鏋滃皬浜?10锛岃鍛婃爣鍑嗚鍙兘涓嶇ǔ瀹?- 5. 濡傛灉鎵€鏈夋鏌ラ€氳繃锛岃繘鍏ユ姤鍛婇樁娈?- 6. 濡傛灉鏈?blocking 绾у埆闂锛屽繀椤讳慨澶嶅悗閲嶆柊浼拌
- 7. 鏈€澶氶噸璇?3 娆★紝3 娆″悗鍚戠敤鎴锋姤鍛婇棶棰樺苟璇锋眰鍐崇瓥

## Automatic Skill Loading
- 鍦ㄥ紑濮嬩换鍔″墠锛屾牴鎹互涓嬭鍒欒嚜鍔ㄥ姞杞?skill锛?- 鏀跺埌 Excel/DTA/CSV 鏂囦欢 -> 鍔犺浇 tabular-ingest锛涘涓哄 sheet Excel 鎴栧宸ヤ綔绨挎暣鐞嗭紝浼樺厛 xlsx-processor
- 鐢ㄦ埛瑕佹眰娓呮礂銆佺瓫閫夈€佹爣鍑嗗寲鎴栭噸缂栫爜鏁版嵁 -> 鍔犺浇 tabular-cleaning
- 鍙戠幇缂哄け鍊奸渶瑕佸鐞?-> 鍔犺浇 missing-data-handler
- 闇€瑕佹瀯閫犱氦浜掗」銆佸鏁般€佹粸鍚庛€佸垎缁勭瓑鏂板彉閲?-> 鍔犺浇 variable-engineering
- 闇€瑕佸揩閫熺悊瑙?CSV 鏁版嵁 -> 鍔犺浇 csv-summarizer
- 闈㈡澘鏁版嵁闇€瑕?QA -> 鍔犺浇 panel-data-qa
- 鍥炲綊瀹屾垚鍚?-> 鍔犺浇 diagnostic-testing 鍜?regression-reporting
- 鐢ㄦ埛瑕佹眰绋冲仴鎬ф楠?-> 鍔犺浇 robustness-check
`

const log = Log.create({ service: "system-prompt" })

async function buildSkillAliasSummary() {
  const aliases = await resolveSkillAliasAvailability().catch(() => [])
  return formatSkillAliasXml(aliases)
}

async function resolveRelativeInstruction(instruction: string): Promise<string[]> {
  if (!Flag.KILLSTATA_DISABLE_PROJECT_CONFIG) {
    return Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])
  }
  if (!Flag.KILLSTATA_CONFIG_DIR) {
    log.warn(
      `Skipping relative instruction "${instruction}" - no KILLSTATA_CONFIG_DIR set while project config is disabled`,
    )
    return []
  }
  return Filesystem.globUp(instruction, Flag.KILLSTATA_CONFIG_DIR, Flag.KILLSTATA_CONFIG_DIR).catch(() => [])
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
          "- Before non-trivial econometric analysis, load workflow-orchestrator with the skill tool, then load the most relevant specialist skill.",
          "- Prefer descriptive-analysis, did-estimation, iv-estimation, psm-estimation, rdd-estimation, regression-reporting, robustness-check, research-briefing, heterogeneity-analysis, paper-drafting, and slide-generator when the task matches them.",
          "- If the user asks for a reasonable baseline, a standard baseline, or says to choose the model yourself, default to econometrics with methodName=\"smart_baseline\".",
          "- If the user asks for recommendation only, without execution, default to econometrics with methodName=\"auto_recommend\".",
          "- If the user explicitly names an estimator, respect that estimator unless it is not executable with the available variables or identifiers.",
          "- When an explicit estimator request is not executable, rescue to smart_baseline or the closest executable baseline and tell the user the original request, why it failed, and what you ran instead.",
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
          "- Before spreadsheet, CSV, Excel, or DTA processing, load workflow-orchestrator with the skill tool, then load the most relevant specialist skill.",
          "- Prefer xlsx-processor, tabular-ingest, tabular-cleaning, and panel-data-qa when the task matches them.",
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
  const USER_WORKSPACE_RULE_FILES = [
    userWorkspaceAgentsPath(),
    userWorkspaceMemoryPath(),
    userWorkspaceUserPath(),
  ]
  if (!Flag.KILLSTATA_DISABLE_CLAUDE_CODE_PROMPT) {
    GLOBAL_RULE_FILES.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
  }

  if (Flag.KILLSTATA_CONFIG_DIR) {
    GLOBAL_RULE_FILES.push(path.join(Flag.KILLSTATA_CONFIG_DIR, "AGENTS.md"))
  }

  export async function custom() {
    const config = await Config.get()
    const paths: string[] = []
    const appendPath = (item: string) => {
      if (!paths.includes(item)) paths.push(item)
    }

    for (const globalRuleFile of GLOBAL_RULE_FILES) {
      if (await Bun.file(globalRuleFile).exists()) {
        appendPath(globalRuleFile)
      }
    }

    for (const workspaceRuleFile of USER_WORKSPACE_RULE_FILES) {
      if (await Bun.file(workspaceRuleFile).exists()) {
        appendPath(workspaceRuleFile)
      }
    }

    if (!Flag.KILLSTATA_DISABLE_PROJECT_CONFIG) {
      for (const localRuleFile of LOCAL_RULE_FILES) {
        const matches = await Filesystem.findUp(localRuleFile, Instance.directory, Instance.worktree)
        if (matches.length > 0) {
          matches.forEach((item) => appendPath(item))
          break
        }
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
        matches.forEach((item) => appendPath(item))
      }
    }

    const foundFiles = paths.map((item) =>
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
