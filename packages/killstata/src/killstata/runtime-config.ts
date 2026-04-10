import fs from "fs"
import path from "path"
import os from "os"
import { spawnSync } from "child_process"
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode, type ParseError as JsoncParseError } from "jsonc-parser"
import { Config } from "@/config/config"
import { Global } from "@/global"

export type PythonProbe = {
  command: string
  resolved: string
  version?: string
  ok: boolean
  error?: string
}

export type PythonPackageReport = {
  checkedWith: string
  missing: string[]
}

export type RuntimePythonSource = "env" | "config" | "managed" | "trae_agent" | "system" | "default"

export type RuntimePythonSelection = {
  executable: string
  source: RuntimePythonSource
}

export type RuntimePythonStatus = RuntimePythonSelection & {
  version?: string
  ok: boolean
  error?: string
  missing: string[]
  installCommand: string
}

export type StataProbe = {
  input: string
  normalized: string
  exists: boolean
  edition?: "mp" | "se" | "be"
}

const WINDOWS_STATA_CANDIDATES = [
  "D:\\stata17",
  "D:\\stata18",
  "C:\\Program Files\\Stata17",
  "C:\\Program Files\\Stata18",
  "C:\\Program Files (x86)\\Stata17",
  "C:\\Program Files\\Stata16",
  "C:\\Program Files (x86)\\Stata18",
  "C:\\Program Files (x86)\\Stata16",
]

const WINDOWS_PREFERRED_PYTHON_CANDIDATES = [
  "D:\\anaconda3\\envs\\trae_agent\\python.exe",
]

export const REQUIRED_PYTHON_PACKAGES = [
  "pandas",
  "numpy",
  "scipy",
  "statsmodels",
  "linearmodels",
  "matplotlib",
  "openpyxl",
  "pyarrow",
  "docx",
] as const

export function defaultPythonCommand() {
  return process.platform === "win32" ? "python" : "python3"
}

export function preferredLocalPythonExecutable() {
  if (process.platform !== "win32") return undefined
  return WINDOWS_PREFERRED_PYTHON_CANDIDATES.find((candidate) => fs.existsSync(candidate))
}

export function describeRuntimePythonSource(source: RuntimePythonSource) {
  switch (source) {
    case "env":
      return "KILLSTATA_PYTHON environment override"
    case "config":
      return "killstata.python.executable config"
    case "managed":
      return "managed killstata virtual environment"
    case "trae_agent":
      return "local trae_agent Anaconda environment"
    case "system":
      return "system Python discovery"
    default:
      return "default python command fallback"
  }
}

export function shellQuote(input: string) {
  if (!/\s/.test(input)) return input
  return `"${input.replace(/"/g, '\\"')}"`
}

export function userRoot() {
  return path.join(Global.Path.home, ".killstata")
}

export function userConfigPath() {
  return path.join(Global.Path.config, "killstata.jsonc")
}

export function legacyUserConfigPath() {
  return path.join(Global.Path.config, "killstata.json")
}

export function managedPythonVenvRoot() {
  return path.join(userRoot(), "venv")
}

export function managedPythonExecutable() {
  return process.platform === "win32"
    ? path.join(managedPythonVenvRoot(), "Scripts", "python.exe")
    : path.join(managedPythonVenvRoot(), "bin", "python")
}

export function managedStataMcpRoot() {
  return path.join(userRoot(), "stata-mcp")
}

export function legacyUserSkillRoot() {
  return path.join(userRoot(), "skill")
}

export function userSkillRoot() {
  return path.join(userRoot(), "skills")
}

export function importedSkillsRoot() {
  return path.join(userSkillRoot(), "imported")
}

export function defaultSkillsRoot() {
  return path.join(userSkillRoot(), "default")
}

export function localSkillsRoot() {
  return path.join(userSkillRoot(), "local")
}

export function cachedSkillsRoot() {
  return path.join(userSkillRoot(), "cache")
}

export function defaultSkillsManifestPath() {
  return path.join(defaultSkillsRoot(), ".managed.json")
}

export function userWorkspaceRoot() {
  return path.join(userRoot(), "workspace")
}

export function userWorkspaceAgentsPath() {
  return path.join(userWorkspaceRoot(), "AGENTS.md")
}

export function userWorkspaceMemoryPath() {
  return path.join(userWorkspaceRoot(), "MEMORY.md")
}

export function userWorkspaceUserPath() {
  return path.join(userWorkspaceRoot(), "USER.md")
}

export function userAgentsRoot() {
  return path.join(userRoot(), "agents")
}

export function userMainAgentRoot() {
  return path.join(userAgentsRoot(), "main")
}

export function userMainAgentStateRoot() {
  return path.join(userMainAgentRoot(), "agent")
}

export function userMainAgentSessionsRoot() {
  return path.join(userMainAgentRoot(), "sessions")
}

export function userMainAgentModelsPath() {
  return path.join(userMainAgentStateRoot(), "models.json")
}

export function userMainAgentAuthProfilesPath() {
  return path.join(userMainAgentStateRoot(), "auth-profiles.json")
}

export function userSubagentsRoot() {
  return path.join(userRoot(), "subagents")
}

export function userSubagentRunsPath() {
  return path.join(userSubagentsRoot(), "runs.json")
}

export function userLogsRoot() {
  return path.join(userRoot(), "logs")
}

export function userMemoryRoot() {
  return path.join(userRoot(), "memory")
}

export function userTmpRoot() {
  return path.join(userRoot(), "tmp")
}

export function userStateRoot() {
  return path.join(userRoot(), "state")
}

export function userDownloadsRoot() {
  return path.join(userRoot(), "downloads")
}

export function userWorkspaceStatePath() {
  return path.join(userStateRoot(), "workspace.json")
}

export function userPaths() {
  return {
    root: userRoot(),
    config: userConfigPath(),
    legacyConfig: legacyUserConfigPath(),
    managedPythonVenv: managedPythonVenvRoot(),
    managedPythonExecutable: managedPythonExecutable(),
    stataMcpRoot: managedStataMcpRoot(),
    legacySkillRoot: legacyUserSkillRoot(),
    skillRoot: userSkillRoot(),
    defaultSkills: defaultSkillsRoot(),
    defaultSkillsManifest: defaultSkillsManifestPath(),
    importedSkills: importedSkillsRoot(),
    localSkills: localSkillsRoot(),
    cachedSkills: cachedSkillsRoot(),
    workspace: userWorkspaceRoot(),
    workspaceAgents: userWorkspaceAgentsPath(),
    workspaceMemory: userWorkspaceMemoryPath(),
    workspaceUser: userWorkspaceUserPath(),
    agents: userAgentsRoot(),
    mainAgentRoot: userMainAgentRoot(),
    mainAgentState: userMainAgentStateRoot(),
    mainAgentSessions: userMainAgentSessionsRoot(),
    mainAgentModels: userMainAgentModelsPath(),
    mainAgentAuthProfiles: userMainAgentAuthProfilesPath(),
    subagents: userSubagentsRoot(),
    subagentRuns: userSubagentRunsPath(),
    logs: userLogsRoot(),
    memory: userMemoryRoot(),
    tmp: userTmpRoot(),
    state: userStateRoot(),
    workspaceState: userWorkspaceStatePath(),
    downloads: userDownloadsRoot(),
  }
}

const USER_WORKSPACE_AGENTS_TEMPLATE = `# Killstata User-Level Rules

Use this file for global Killstata preferences that should apply across projects.

- Put durable personal defaults here.
- Keep project-specific implementation rules in the project's AGENTS.md.
- Update this file when the user wants Killstata's default behavior to change globally.
`

const USER_WORKSPACE_MEMORY_TEMPLATE = `# Killstata Persistent Memory

Store only information the user explicitly asked Killstata to remember long term.

- Do not store temporary task context here.
- Prefer concise, durable rules and preferences.
- Remove outdated items when the user supersedes them.
`

const USER_WORKSPACE_USER_TEMPLATE = `# Killstata User Profile

Summarize stable user preferences or working style only when the user explicitly asks to update this profile.

- This file is read by default.
- Do not auto-write session summaries here.
- Keep entries short and behavior-focused.
`

export function shortenHomePath(input: string) {
  const home = Global.Path.home
  return input.startsWith(home) ? input.replace(home, "~") : input
}

function runProcess(command: string, args: string[]) {
  return spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  })
}

export function resolveCommand(command: string) {
  if (path.isAbsolute(command)) return command
  const direct = Bun.which(command)
  if (direct) return direct
  if (process.platform !== "win32") return undefined
  try {
    const proc = runProcess("where.exe", [command])
    if (proc.status !== 0) return undefined
    return proc.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
  } catch {
    return undefined
  }
}

export function probePythonExecutable(command: string): PythonProbe {
  const resolved = resolveCommand(command) ?? command
  try {
    const proc = runProcess(resolved, ["--version"])
    const output = `${proc.stdout}\n${proc.stderr}`.trim()
    if (proc.status !== 0) {
      return {
        command,
        resolved,
        ok: false,
        error: output || `Exit code ${proc.status}`,
      }
    }
    return {
      command,
      resolved,
      ok: true,
      version: output.split(/\r?\n/).find(Boolean)?.trim(),
    }
  } catch (error) {
    return {
      command,
      resolved,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function discoverSystemPython(): PythonProbe | undefined {
  const candidates = process.platform === "win32"
    ? [
        "python",
        "python3",
        "py",
      ]
    : [
        "python3",
        "python",
      ]

  for (const candidate of candidates) {
    const args = candidate === "py" ? ["-3", "--version"] : ["--version"]
    const resolved = resolveCommand(candidate)
    if (!resolved) continue
    try {
      const proc = runProcess(resolved, args)
      const output = `${proc.stdout}\n${proc.stderr}`.trim()
      if (proc.status === 0) {
        return {
          command: candidate,
          resolved,
          ok: true,
          version: output.split(/\r?\n/).find(Boolean)?.trim(),
        }
      }
    } catch {
      continue
    }
  }
  return undefined
}

export async function resolveRuntimePythonSelection(): Promise<RuntimePythonSelection> {
  const envOverride = process.env.KILLSTATA_PYTHON?.trim()
  if (envOverride) {
    return {
      executable: envOverride,
      source: "env",
    }
  }

  const config = await Config.get()
  const configured = config.killstata?.python?.executable?.trim()
  if (configured) {
    return {
      executable: configured,
      source: "config",
    }
  }

  const managed = config.killstata?.python?.managed
  if (managed && fs.existsSync(managedPythonExecutable())) {
    return {
      executable: managedPythonExecutable(),
      source: "managed",
    }
  }

  const preferred = preferredLocalPythonExecutable()
  if (preferred) {
    return {
      executable: preferred,
      source: "trae_agent",
    }
  }

  const system = discoverSystemPython()?.resolved
  if (system) {
    return {
      executable: system,
      source: "system",
    }
  }

  return {
    executable: defaultPythonCommand(),
    source: "default",
  }
}

export async function resolveConfiguredPythonExecutable() {
  return (await resolveRuntimePythonSelection()).executable
}

export async function resolveRuntimePythonCommand() {
  return (await resolveConfiguredPythonExecutable()) ?? defaultPythonCommand()
}

export function pythonInstallCommand(
  pythonExecutable: string,
  packages = [...REQUIRED_PYTHON_PACKAGES],
) {
  return `${shellQuote(pythonExecutable)} -m pip install ${packages.join(" ")}`
}

export function checkPythonPackages(pythonExecutable: string, packages = [...REQUIRED_PYTHON_PACKAGES]): PythonPackageReport {
  const script = [
    "import importlib.util, json",
    `packages = ${JSON.stringify(packages)}`,
    "missing = [pkg for pkg in packages if importlib.util.find_spec(pkg) is None]",
    "print(json.dumps({'missing': missing}))",
  ].join("\n")

  const proc = runProcess(pythonExecutable, ["-c", script])
  if (proc.status !== 0) {
    throw new Error((`${proc.stdout}\n${proc.stderr}`).trim() || `Failed to inspect packages with ${pythonExecutable}`)
  }

  const parsed = JSON.parse(proc.stdout.trim() || "{}") as { missing?: string[] }
  return {
    checkedWith: pythonExecutable,
    missing: parsed.missing ?? [],
  }
}

export async function getRuntimePythonStatus(packages = [...REQUIRED_PYTHON_PACKAGES]): Promise<RuntimePythonStatus> {
  const selection = await resolveRuntimePythonSelection()
  const probe = probePythonExecutable(selection.executable)
  const executable = probe.resolved || selection.executable
  const installCommand = pythonInstallCommand(executable, packages)

  if (!probe.ok) {
    return {
      executable,
      source: selection.source,
      ok: false,
      error: probe.error ?? `Unable to run ${selection.executable}`,
      missing: [...packages],
      installCommand,
    }
  }

  try {
    const report = checkPythonPackages(executable, packages)
    return {
      executable,
      source: selection.source,
      version: probe.version,
      ok: true,
      missing: report.missing,
      installCommand,
    }
  } catch (error) {
    return {
      executable,
      source: selection.source,
      version: probe.version,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      missing: [],
      installCommand,
    }
  }
}

export function formatRuntimePythonSetupError(toolName: string, status: RuntimePythonStatus) {
  const lines = [
    `${toolName} Python runtime is not ready.`,
    `Interpreter: ${status.executable}`,
    `Selected from: ${describeRuntimePythonSource(status.source)}`,
  ]

  if (status.version) lines.push(`Version: ${status.version}`)
  if (!status.ok && status.error) lines.push(`Probe error: ${status.error}`)
  if (status.missing.length) lines.push(`Missing packages: ${status.missing.join(", ")}`)

  lines.push(`Install command: ${status.installCommand}`)
  lines.push("Next step: run `killstata config` or `killstata config doctor` before retrying.")
  return lines.join("\n")
}

export function ensureManagedPythonVenv(pythonExecutable: string) {
  fs.mkdirSync(userRoot(), { recursive: true })
  if (fs.existsSync(managedPythonExecutable())) return managedPythonExecutable()

  const proc = runProcess(pythonExecutable, ["-m", "venv", managedPythonVenvRoot()])
  if (proc.status !== 0 || !fs.existsSync(managedPythonExecutable())) {
    throw new Error((`${proc.stdout}\n${proc.stderr}`).trim() || "Failed to create managed Python virtual environment")
  }
  return managedPythonExecutable()
}

export function installPythonPackages(pythonExecutable: string, packages = [...REQUIRED_PYTHON_PACKAGES]) {
  const upgradePip = runProcess(pythonExecutable, ["-m", "pip", "install", "--upgrade", "pip"])
  if (upgradePip.status !== 0) {
    throw new Error((`${upgradePip.stdout}\n${upgradePip.stderr}`).trim() || "Failed to upgrade pip")
  }

  const install = runProcess(pythonExecutable, ["-m", "pip", "install", ...packages])
  if (install.status !== 0) {
    throw new Error((`${install.stdout}\n${install.stderr}`).trim() || "Failed to install Python packages")
  }
}

export function normalizeStataPath(input: string) {
  const trimmed = input.trim().replace(/^["']|["']$/g, "")
  if (!trimmed) throw new Error("Stata path is required.")
  return path.resolve(path.normalize(trimmed))
}

export function inferStataEdition(input: string): "mp" | "se" | "be" | undefined {
  const lower = input.toLowerCase()
  if (lower.includes("statamp")) return "mp"
  if (lower.includes("statase")) return "se"
  if (lower.includes("stata")) return "be"
  return undefined
}

export function probeStataPath(input: string): StataProbe {
  const normalized = normalizeStataPath(input)
  return {
    input,
    normalized,
    exists: fs.existsSync(normalized),
    edition: inferStataEdition(normalized),
  }
}

export function detectStataCandidates() {
  const directCandidates = process.platform === "win32" ? WINDOWS_STATA_CANDIDATES : []
  return directCandidates.filter((candidate) => fs.existsSync(candidate))
}

type JsonPathValue = {
  path: string[]
  value: unknown
}

function formatJsoncErrors(text: string, filepath: string, errors: JsoncParseError[]) {
  const lines = text.split("\n")
  const details = errors
    .map((item) => {
      const beforeOffset = text.substring(0, item.offset).split("\n")
      const line = beforeOffset.length
      const column = beforeOffset[beforeOffset.length - 1].length + 1
      const problemLine = lines[line - 1]
      const error = `${printParseErrorCode(item.error)} at line ${line}, column ${column}`
      if (!problemLine) return error
      return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
    })
    .join("\n")
  throw new Error(`Failed to parse ${filepath}\n${details}`)
}

export async function writeUserConfigValues(values: JsonPathValue[]) {
  fs.mkdirSync(userRoot(), { recursive: true })
  const filepath = userConfigPath()
  let text = await Bun.file(filepath).text().catch(() => "")
  if (!text.trim()) text = "{}"

  let next = text
  for (const item of values) {
    const edits = modify(next, item.path, item.value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    next = applyEdits(next, edits)
  }

  const errors: JsoncParseError[] = []
  parseJsonc(next, errors, { allowTrailingComma: true })
  if (errors.length) formatJsoncErrors(next, filepath, errors)

  await Bun.write(filepath, next)
  await Config.invalidate()
}

export async function writeUserConfigPatch(input: Config.Info) {
  const values: JsonPathValue[] = [{ path: ["$schema"], value: "https://killstata.io/config.json" }]
  const visit = (prefix: string[], value: unknown) => {
    if (value === undefined) return
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        visit([...prefix, key], child)
      }
      return
    }
    values.push({ path: prefix, value })
  }

  visit([], input)
  await writeUserConfigValues(values)
}

async function ensureJsonFile(filepath: string, fallback: unknown) {
  if (fs.existsSync(filepath)) return
  fs.mkdirSync(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, JSON.stringify(fallback, null, 2))
}

async function ensureTextFile(filepath: string, fallback: string) {
  if (fs.existsSync(filepath)) return
  fs.mkdirSync(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, fallback)
}

export async function ensureKillstataHomeDirectories() {
  const paths = userPaths()

  fs.mkdirSync(paths.root, { recursive: true })

  if (fs.existsSync(paths.legacySkillRoot) && !fs.existsSync(paths.skillRoot)) {
    fs.renameSync(paths.legacySkillRoot, paths.skillRoot)
  }

  const directories = [
    paths.managedPythonVenv,
    paths.stataMcpRoot,
    paths.skillRoot,
    paths.defaultSkills,
    paths.importedSkills,
    paths.localSkills,
    paths.cachedSkills,
    paths.workspace,
    paths.agents,
    paths.mainAgentRoot,
    paths.mainAgentState,
    paths.mainAgentSessions,
    paths.subagents,
    paths.logs,
    paths.memory,
    paths.tmp,
    paths.state,
    paths.downloads,
  ]

  for (const dir of directories) {
    fs.mkdirSync(dir, { recursive: true })
  }

  await ensureJsonFile(paths.mainAgentModels, {})
  await ensureJsonFile(paths.mainAgentAuthProfiles, {})
  await ensureJsonFile(paths.subagentRuns, [])
  await ensureJsonFile(paths.workspaceState, {})
  await ensureTextFile(paths.workspaceAgents, USER_WORKSPACE_AGENTS_TEMPLATE)
  await ensureTextFile(paths.workspaceMemory, USER_WORKSPACE_MEMORY_TEMPLATE)
  await ensureTextFile(paths.workspaceUser, USER_WORKSPACE_USER_TEMPLATE)

  return paths
}

export function runtimePaths(projectRoot: string) {
  const xdgStorageRoot = path.join(Global.Path.data, "storage")
  const xdgSnapshotRoot = path.join(Global.Path.data, "snapshot")
  const user = userPaths()
  return {
    user,
    xdg: {
      config: Global.Path.config,
      data: Global.Path.data,
      cache: Global.Path.cache,
      state: Global.Path.state,
      log: Global.Path.log,
      storage: xdgStorageRoot,
      snapshot: xdgSnapshotRoot,
      auth: path.join(Global.Path.data, "auth.json"),
      mcpAuth: path.join(Global.Path.data, "mcp-auth.json"),
    },
    project: {
      root: projectRoot,
      internal: path.join(projectRoot, ".killstata"),
      outputs: path.join(projectRoot, "killstata_outputs"),
      projectConfig: path.join(projectRoot, "killstata.jsonc"),
    },
  }
}
