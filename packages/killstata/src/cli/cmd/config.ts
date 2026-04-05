import * as prompts from "@clack/prompts"
import fs from "fs"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Instance } from "../../project/instance"
import { Config } from "../../config/config"
import { defaultSkillsRoot, ensureSkillDirectories, importedSkillsRoot, localSkillsRoot, userSkillsRoot } from "../../skill"
import { createBuiltInStataMcpConfig, StataEdition } from "../../mcp/stata"
import {
  checkPythonPackages,
  describeRuntimePythonSource,
  detectStataCandidates,
  ensureKillstataHomeDirectories,
  getRuntimePythonStatus,
  inferStataEdition,
  installPythonPackages,
  managedPythonExecutable,
  managedPythonVenvRoot,
  preferredLocalPythonExecutable,
  probePythonExecutable,
  probeStataPath,
  REQUIRED_PYTHON_PACKAGES,
  resolveConfiguredPythonExecutable,
  runtimePaths,
  shortenHomePath,
  userConfigPath,
  userDownloadsRoot,
  userLogsRoot,
  userMainAgentSessionsRoot,
  userMainAgentStateRoot,
  userMemoryRoot,
  userSkillRoot,
  userStateRoot,
  userSubagentRunsPath,
  userSubagentsRoot,
  userTmpRoot,
  userWorkspaceRoot,
  writeUserConfigPatch,
} from "@/killstata/runtime-config"

type Finding = {
  level: "ok" | "warn" | "error"
  label: string
  detail: string
}

const REQUIRED_PYTHON_PACKAGES_TEXT = REQUIRED_PYTHON_PACKAGES.join(", ")

function projectRoot() {
  return Instance.project.vcs ? Instance.worktree : Instance.directory
}

function logFindings(findings: Finding[]) {
  for (const item of findings) {
    const line = `${item.label}: ${item.detail}`
    if (item.level === "ok") {
      prompts.log.success(line)
      continue
    }
    if (item.level === "warn") {
      prompts.log.warn(line)
      continue
    }
    prompts.log.error(line)
  }
}

function printPathSummary() {
  const paths = runtimePaths(projectRoot())

  prompts.log.info("User-level files live under ~/.killstata")
  prompts.log.info(`  config: ${paths.user.config}`)
  prompts.log.info(`  workspace: ${paths.user.workspace}`)
  prompts.log.info(`  managed econometrics venv: ${paths.user.managedPythonVenv}`)
  prompts.log.info(`  managed Stata MCP home: ${paths.user.stataMcpRoot}`)
  prompts.log.info(`  skills: ${paths.user.skillRoot}`)
  prompts.log.info(`  default skills: ${paths.user.defaultSkills}`)
  prompts.log.info(`  agents: ${paths.user.agents}`)
  prompts.log.info(`  main agent state: ${paths.user.mainAgentState}`)
  prompts.log.info(`  main agent sessions: ${paths.user.mainAgentSessions}`)
  prompts.log.info(`  subagents: ${paths.user.subagents}`)
  prompts.log.info(`  subagent index: ${paths.user.subagentRuns}`)
  prompts.log.info(`  logs: ${paths.user.logs}`)
  prompts.log.info(`  memory: ${paths.user.memory}`)
  prompts.log.info(`  tmp: ${paths.user.tmp}`)
  prompts.log.info(`  state: ${paths.user.state}`)
  prompts.log.info(`  downloads: ${paths.user.downloads}`)
  prompts.log.info(`  global config file: ${paths.user.config}`)
  prompts.log.info(`  legacy skills root: ${paths.user.legacySkillRoot}`)

  prompts.log.info("Runtime compatibility state lives under XDG/AppData killstata")
  prompts.log.info(`  config: ${paths.xdg.config}`)
  prompts.log.info(`  data: ${paths.xdg.data}`)
  prompts.log.info(`  storage: ${paths.xdg.storage}`)
  prompts.log.info(`  snapshot: ${paths.xdg.snapshot}`)
  prompts.log.info(`  cache: ${paths.xdg.cache}`)
  prompts.log.info(`  state: ${paths.xdg.state}`)
  prompts.log.info(`  log: ${paths.xdg.log}`)
  prompts.log.info(`  auth: ${paths.xdg.auth}`)
  prompts.log.info(`  mcp auth: ${paths.xdg.mcpAuth}`)

  prompts.log.info("Project-level analysis data stays in the current project")
  prompts.log.info(`  internal state: ${paths.project.internal}`)
  prompts.log.info(`  visible outputs: ${paths.project.outputs}`)
  prompts.log.info(`  project override config: ${paths.project.projectConfig}`)
}

async function promptPythonPath(input: { current?: string; recommended?: string }) {
  const discovered = input.current ? probePythonExecutable(input.current) : undefined
  const recommended = input.recommended ? probePythonExecutable(input.recommended) : undefined
  const options = []
  const sameResolvedPython = discovered?.ok && recommended?.ok && discovered.resolved === recommended.resolved

  if (recommended?.ok) {
    options.push({
      label: `Use recommended Python (${recommended.version ?? recommended.resolved})`,
      value: "recommended",
      hint: recommended.resolved,
    })
  }

  if (discovered?.ok && discovered.resolved !== recommended?.resolved) {
    options.push({
      label: `Use detected Python (${discovered.version ?? discovered.resolved})`,
      value: "detected",
      hint: discovered.resolved,
    })
  }

  options.push({
    label: "Enter a custom Python path",
    value: "custom",
    hint: "Use this if Python is installed but not on PATH",
  })
  options.push({
    label: "Skip Python setup for now",
    value: "skip",
    hint: "Data and econometrics features require Python plus the required packages",
  })

  const choice = await prompts.select({
    message: "Configure Python for data processing and econometrics?",
    options,
    initialValue: recommended?.ok ? "recommended" : discovered?.ok && !sameResolvedPython ? "detected" : "custom",
  })
  if (prompts.isCancel(choice)) throw new UI.CancelledError()

  if (choice === "skip") return undefined
  if (choice === "recommended" && recommended?.ok) return recommended.resolved
  if (choice === "detected" && discovered?.ok) return discovered.resolved

  const custom = await prompts.text({
    message: "Enter a Python executable path",
    placeholder:
      input.current && !discovered?.ok
        ? input.current
        : process.platform === "win32"
          ? "C:\\Python311\\python.exe"
          : "/usr/bin/python3",
    validate: (value) => {
      if (!value?.trim()) return undefined
      const probe = probePythonExecutable(value.trim())
      return probe.ok ? undefined : `Unable to run Python: ${probe.error ?? "unknown error"}`
    },
  })
  if (prompts.isCancel(custom)) throw new UI.CancelledError()
  return custom.trim() || undefined
}

async function configurePython(existing: Awaited<ReturnType<typeof Config.get>>) {
  const configured = existing.killstata?.python?.executable?.trim()
  const recommended = preferredLocalPythonExecutable()
  const fallback = configured || recommended || (await resolveConfiguredPythonExecutable())
  const selected = await promptPythonPath({
    current: fallback,
    recommended: configured ? undefined : recommended,
  })

  if (!selected) {
    prompts.log.warn("Python setup skipped.")
    prompts.log.warn("Python is required for data import, cleaning, and econometric analysis in Killstata.")
    prompts.log.warn(`Required Python packages: ${REQUIRED_PYTHON_PACKAGES_TEXT}`)
    prompts.log.warn("Install Python 3.9+ and rerun `killstata config` before using those features.")
    return undefined
  }

  const probe = probePythonExecutable(selected)
  if (!probe.ok) {
    prompts.log.error(`Python probe failed: ${probe.error ?? selected}`)
    return undefined
  }

  prompts.log.success(`Python ready: ${probe.version ?? "detected"} at ${probe.resolved}`)
  if (recommended && probe.resolved === recommended) {
    prompts.log.info("Using recommended local trae_agent Python environment.")
  }

  let packageReport
  try {
    packageReport = checkPythonPackages(probe.resolved)
  } catch (error) {
    prompts.log.warn(`Could not inspect Python packages with ${probe.resolved}: ${error instanceof Error ? error.message : String(error)}`)
    return {
      executable: probe.resolved,
      managed: false,
    }
  }

  if (packageReport.missing.length === 0) {
    prompts.log.success(`Required Python packages are already available in ${probe.resolved}`)
    return {
      executable: probe.resolved,
      managed: false,
    }
  }

  prompts.log.warn(`Missing Python packages: ${packageReport.missing.join(", ")}`)
  const installIntoSelected = await prompts.confirm({
    message: `Install the required packages into ${probe.resolved}?`,
    initialValue: true,
  })
  if (prompts.isCancel(installIntoSelected)) throw new UI.CancelledError()

  if (!installIntoSelected) {
    prompts.log.warn(`Leaving Python configured without installing dependencies. Econometrics may fail until ${packageReport.missing.join(", ")} are installed.`)
    return {
      executable: probe.resolved,
      managed: probe.resolved === managedPythonExecutable(),
    }
  }

  const spinner = prompts.spinner()
  spinner.start(`Installing required Python packages into ${probe.resolved}`)
  try {
    installPythonPackages(probe.resolved, [...REQUIRED_PYTHON_PACKAGES])
    spinner.stop(`Python packages installed into ${probe.resolved}`)
    return {
      executable: probe.resolved,
      managed: probe.resolved === managedPythonExecutable(),
    }
  } catch (error) {
    spinner.stop("Python package installation failed", 1)
    throw error
  }
}

async function promptStataPath(existingPath?: string) {
  const candidates = Array.from(new Set([...(existingPath ? [existingPath] : []), ...detectStataCandidates()]))
  const options = candidates.map((candidate) => ({
    label: candidate,
    value: candidate,
    hint: probeStataPath(candidate).exists ? "detected" : "configured",
  }))

  options.push({
    label: "Enter a custom Stata path",
    value: "__custom__",
    hint: "Directory or executable path",
  })
  options.push({
    label: "Skip Stata setup for now",
    value: "__skip__",
    hint: "Stata is optional",
  })

  const selected = await prompts.select({
    message: "Configure Stata and the built-in Stata MCP now?",
    options,
    initialValue: candidates[0] ?? "__custom__",
  })
  if (prompts.isCancel(selected)) throw new UI.CancelledError()
  if (selected === "__skip__") return undefined
  if (selected !== "__custom__") return selected

  const custom = await prompts.text({
    message: "Enter the Stata installation directory or executable path",
    placeholder: process.platform === "win32" ? "D:\\stata17" : undefined,
    validate: (value) => {
      if (!value?.trim()) return undefined
      try {
        const probe = probeStataPath(value.trim())
        return probe.exists ? undefined : `Path does not exist: ${probe.normalized}`
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
  })
  if (prompts.isCancel(custom)) throw new UI.CancelledError()
  return custom.trim() || undefined
}

async function configureStata(existing: Awaited<ReturnType<typeof Config.get>>) {
  const shouldConfigure = await prompts.confirm({
    message: "Configure Stata now?",
    initialValue: !!existing.killstata?.stata?.path || detectStataCandidates().length > 0,
  })
  if (prompts.isCancel(shouldConfigure)) throw new UI.CancelledError()
  if (!shouldConfigure) {
    prompts.log.warn("Stata setup skipped. You can still use non-Stata features.")
    return undefined
  }

  const selected = await promptStataPath(existing.killstata?.stata?.path)
  if (!selected) return undefined

  const probe = probeStataPath(selected)
  if (!probe.exists) {
    prompts.log.error(`Stata path not found: ${probe.normalized}`)
    return undefined
  }

  const edition = await prompts.select({
    message: "Select the Stata edition",
    options: [
      { label: "MP", value: "mp", hint: "Recommended default" },
      { label: "SE", value: "se", hint: "Standard Edition" },
      { label: "BE", value: "be", hint: "Basic Edition" },
    ],
    initialValue: existing.killstata?.stata?.edition ?? inferStataEdition(probe.normalized) ?? "mp",
  })
  if (prompts.isCancel(edition)) throw new UI.CancelledError()

  const parsedEdition = StataEdition.parse(edition)
  prompts.log.success(`Stata configured at ${probe.normalized} (${parsedEdition.toUpperCase()})`)

  return {
    path: probe.normalized,
    edition: parsedEdition,
    mcp: createBuiltInStataMcpConfig(probe.normalized, parsedEdition),
  }
}

async function configureWorkspace(existing: Awaited<ReturnType<typeof Config.get>>) {
  const enabled = await prompts.confirm({
    message: "Enable the global ~/.killstata/workspace for non-project code generation and scratch files?",
    initialValue: existing.killstata?.workspace?.enabled ?? true,
  })
  if (prompts.isCancel(enabled)) throw new UI.CancelledError()

  if (!enabled) {
    prompts.log.warn("Global user workspace disabled. Project-local outputs remain unchanged.")
    return {
      enabled: false,
      root: userWorkspaceRoot(),
    }
  }

  prompts.log.success(`Global workspace enabled at ${userWorkspaceRoot()}`)
  return {
    enabled: true,
    root: userWorkspaceRoot(),
  }
}

function printFinalSummary(input: {
  python?: {
    executable: string
    managed: boolean
  }
  workspace: {
    enabled: boolean
    root: string
  }
  stata?: {
    path: string
    edition: "mp" | "se" | "be"
  }
}) {
  prompts.log.success(`User config written to ${userConfigPath()}`)
  prompts.log.info(
    `Skill directories ready: ${userSkillsRoot()}, ${defaultSkillsRoot()}, ${importedSkillsRoot()}, ${localSkillsRoot()}`,
  )
  prompts.log.info(`Global workspace: ${input.workspace.enabled ? input.workspace.root : "disabled"}`)
  prompts.log.info(`Agent state root: ${userMainAgentStateRoot()}`)
  prompts.log.info(`Agent sessions root: ${userMainAgentSessionsRoot()}`)
  prompts.log.info(`Subagent index: ${userSubagentRunsPath()}`)

  if (input.python) {
    prompts.log.info(
      `Python: ${input.python.executable}${input.python.managed ? ` (managed env at ${shortenHomePath(managedPythonVenvRoot())})` : ""}`,
    )
  } else {
    prompts.log.warn(`Python: not configured (required for data/econometrics; packages needed: ${REQUIRED_PYTHON_PACKAGES_TEXT})`)
  }

  if (input.stata) {
    prompts.log.info(`Stata: ${input.stata.path} (${input.stata.edition.toUpperCase()})`)
    prompts.log.info("Built-in Stata MCP: configured as mcp.stata")
  } else {
    prompts.log.warn("Stata: not configured (optional)")
  }
}

export async function runKillstataConfigWizard(input?: { intro?: string }) {
  UI.empty()
  prompts.intro(input?.intro ?? "killstata config")
  await ensureKillstataHomeDirectories()
  await ensureSkillDirectories()
  printPathSummary()

  const existing = await Config.get()
  const paths = runtimePaths(projectRoot())
  const workspace = await configureWorkspace(existing)
  const python = await configurePython(existing)
  const stata = await configureStata(existing)

  const patch: Config.Info = {
    $schema: "https://killstata.io/config.json",
    killstata: {
      home: {
        root: paths.user.root,
      },
      workspace: {
        enabled: workspace.enabled,
        root: workspace.root,
      },
      skills: {
        root: userSkillRoot(),
      },
      agents: {
        root: paths.user.agents,
        main: {
          root: paths.user.mainAgentRoot,
          stateRoot: userMainAgentStateRoot(),
          sessionsRoot: userMainAgentSessionsRoot(),
        },
        subagents: {
          root: userSubagentsRoot(),
          runsPath: userSubagentRunsPath(),
        },
      },
      logs: {
        root: userLogsRoot(),
      },
      memory: {
        root: userMemoryRoot(),
      },
      tmp: {
        root: userTmpRoot(),
      },
      state: {
        root: userStateRoot(),
      },
      downloads: {
        root: userDownloadsRoot(),
      },
    },
  }

  if (python) {
    patch.killstata!.python = {
      executable: python.executable,
      managed: python.managed,
    }
  }
  if (stata) {
    patch.killstata!.stata = {
      path: stata.path,
      edition: stata.edition,
    }
    patch.mcp = {
      stata: stata.mcp,
    }
  }

  await writeUserConfigPatch(patch)
  printFinalSummary({
    python,
    workspace,
    stata: stata
      ? {
          path: stata.path,
          edition: stata.edition,
        }
      : undefined,
  })
  prompts.outro("Configuration complete")
}

export async function runKillstataConfigDoctor() {
  UI.empty()
  prompts.intro("killstata config doctor")

  const config = await Config.get()
  const findings: Finding[] = []
  const paths = runtimePaths(projectRoot())

  const pythonStatus = await getRuntimePythonStatus()
  if (!pythonStatus.ok && !pythonStatus.version && pythonStatus.source === "default") {
    findings.push({
      level: "warn",
      label: "Python",
      detail: "Not configured and not found on PATH. Install Python 3.9+ or rerun `killstata config`.",
    })
  } else {
    if (!pythonStatus.ok) {
      findings.push({
        level: "error",
        label: "Python",
        detail: `Selected ${pythonStatus.executable} from ${describeRuntimePythonSource(pythonStatus.source)} but probe failed: ${pythonStatus.error ?? "unknown error"}`,
      })
    } else {
      findings.push({
        level: "ok",
        label: "Python",
        detail: `${pythonStatus.version ?? "detected"} at ${pythonStatus.executable} (${describeRuntimePythonSource(pythonStatus.source)})`,
      })
    }

    if (pythonStatus.ok) {
      if (pythonStatus.missing.length === 0) {
        findings.push({
          level: "ok",
          label: "Python packages",
          detail: "All required econometrics packages are installed.",
        })
      } else {
        findings.push({
          level: "warn",
          label: "Python packages",
          detail: `Missing packages: ${pythonStatus.missing.join(", ")}. Install with: ${pythonStatus.installCommand}`,
        })
      }
    }
  }

  const stataPath = config.killstata?.stata?.path
  if (!stataPath) {
    findings.push({
      level: "warn",
      label: "Stata",
      detail: "Not configured. Stata MCP remains optional.",
    })
  } else {
    const probe = probeStataPath(stataPath)
    if (!probe.exists) {
      findings.push({
        level: "error",
        label: "Stata",
        detail: `Configured path does not exist: ${probe.normalized}`,
      })
    } else {
      findings.push({
        level: "ok",
        label: "Stata",
        detail: `${probe.normalized} (${(config.killstata?.stata?.edition ?? probe.edition ?? "mp").toUpperCase()})`,
      })
    }
  }

  const stataMcp = config.mcp?.["stata"]
  if (!stataMcp || typeof stataMcp !== "object" || !("type" in stataMcp)) {
    findings.push({
      level: "warn",
      label: "Stata MCP",
      detail: "mcp.stata is not configured in user or project config.",
    })
  } else if (stataMcp.type !== "local") {
    findings.push({
      level: "warn",
      label: "Stata MCP",
      detail: "mcp.stata exists but is not using the built-in local transport.",
    })
  } else {
    findings.push({
      level: "ok",
      label: "Stata MCP",
      detail: `Configured local command: ${stataMcp.command.join(" ")}`,
    })
  }

  findings.push({
    level: "ok",
    label: "User config",
    detail: userConfigPath(),
  })

  for (const check of [
    { label: "Skills root", target: paths.user.skillRoot },
    { label: "Default skills root", target: paths.user.defaultSkills },
    { label: "Workspace root", target: paths.user.workspace },
    { label: "Agent state root", target: paths.user.mainAgentState },
    { label: "Agent sessions root", target: paths.user.mainAgentSessions },
    { label: "Subagent index", target: paths.user.subagentRuns },
  ]) {
    const exists = fs.existsSync(check.target)
    findings.push({
      level: exists ? "ok" : "warn",
      label: check.label,
      detail: exists ? check.target : `Missing: ${check.target}. Run \`killstata config\` to initialize the user home layout.`,
    })
  }

  logFindings(findings)
  prompts.outro("Doctor check complete")
}

export async function runKillstataConfigPaths() {
  UI.empty()
  prompts.intro("killstata config paths")
  printPathSummary()
  prompts.outro("Path summary complete")
}

const ConfigDoctorCommand = cmd({
  command: "doctor",
  describe: "check Python, Stata, and MCP setup without modifying configuration",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        await runKillstataConfigDoctor()
      },
    })
  },
})

const ConfigPathsCommand = cmd({
  command: "paths",
  describe: "show which files live in ~/.killstata, XDG/AppData, and the current project",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        await runKillstataConfigPaths()
      },
    })
  },
})

export const ConfigCommand = cmd({
  command: "config",
  describe: "guided setup for Python, Stata, and killstata storage paths",
  builder: (yargs) => yargs.command(ConfigDoctorCommand).command(ConfigPathsCommand),
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        await runKillstataConfigWizard()
      },
    })
  },
})
