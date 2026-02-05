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

// 计量经济学分析专用提示词
const ECONOMETRICS_CONTEXT = `
# Econometric Analysis Context

You are operating as an econometric analysis assistant. When working with data:

## Data Awareness Priority
- Always scan the working directory for data files (csv, xlsx, dta, sav) before analysis
- Summarize dataset structure: rows, columns, variable types, missing values
- Identify potential panel structure (unit ID + time variables)
- Check for treatment/outcome variables based on naming conventions

## Method Selection Protocol
When user describes a research question, determine the appropriate method:
- Descriptive goal → Summary statistics, visualization
- Causal inference with treatment timing → DID (check parallel trends)
- Assignment variable with cutoff → RDD
- Valid instrument available → IV/2SLS
- Selection on observables → PSM/IPW
- Otherwise → OLS with robust/clustered standard errors

## Academic Standards
- Report coefficients with significance levels (*, **, ***)
- Include standard errors (robust or clustered)
- Run diagnostic tests: heteroskedasticity, multicollinearity
- Discuss effect sizes and economic significance
- State assumptions and limitations

## Tool Integration
- Use the econometrics tool for method-specific analysis
- Use the data_import tool for data preprocessing
- Save results to structured files for reproducibility
`
import type { Provider } from "@/provider/provider"
import { Flag } from "@/flag/flag"

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
  export function header(providerID: string) {
    if (providerID.includes("anthropic")) return [PROMPT_ANTHROPIC_SPOOF.trim()]
    return []
  }

  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export function provider(model: Provider.Model) {
    // 基础提示词选择
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

    // 始终附加计量分析上下文
    return [basePrompt, ECONOMETRICS_CONTEXT]
  }

  export async function environment() {
    const project = Instance.project

    // 扫描数据文件
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

  // 扫描工作目录中的数据文件
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
          })
        ).catch(() => [])

        // 限制每种类型最多5个文件
        results.push(...matches.slice(0, 5))
      }
    } catch {
      // 忽略扫描错误
    }

    return results.slice(0, 20) // 总共最多20个文件
  }

  const LOCAL_RULE_FILES = [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTEXT.md", // deprecated
  ]
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

    // Only scan local rule files when project discovery is enabled
    if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
      for (const localRuleFile of LOCAL_RULE_FILES) {
        const matches = await Filesystem.findUp(localRuleFile, Instance.directory, Instance.worktree)
        if (matches.length > 0) {
          matches.forEach((path) => paths.add(path))
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
        matches.forEach((path) => paths.add(path))
      }
    }

    const foundFiles = Array.from(paths).map((p) =>
      Bun.file(p)
        .text()
        .catch(() => "")
        .then((x) => "Instructions from: " + p + "\n" + x),
    )
    const foundUrls = urls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "")
        .then((x) => (x ? "Instructions from: " + url + "\n" + x : "")),
    )
    return Promise.all([...foundFiles, ...foundUrls]).then((result) => result.filter(Boolean))
  }
}
