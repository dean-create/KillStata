import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"
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
  "python-docx",
] as const

const MANAGED_PYTHON_VERSION = "3.12"
const UV_VERSION = "0.11.16"

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

export function managedRuntimeRoot() {
  return path.join(userRoot(), "runtime")
}

export function managedPythonInstallRoot() {
  return path.join(managedRuntimeRoot(), "python")
}

export function managedUvRoot() {
  return path.join(managedRuntimeRoot(), "uv")
}

export function managedUvExecutable() {
  return path.join(managedUvRoot(), process.platform === "win32" ? "uv.exe" : "uv")
}

export function managedPythonExecutable() {
  return process.platform === "win32"
    ? path.join(managedPythonVenvRoot(), "Scripts", "python.exe")
    : path.join(managedPythonVenvRoot(), "bin", "python")
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
    managedRuntime: managedRuntimeRoot(),
    managedPythonInstall: managedPythonInstallRoot(),
    managedUv: managedUvExecutable(),
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

function runProcess(command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      ...extraEnv,
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

  if (fs.existsSync(managedPythonExecutable())) {
    return {
      executable: managedPythonExecutable(),
      source: "managed",
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
  packages: readonly string[] = [...REQUIRED_PYTHON_PACKAGES],
) {
  const pipPackages = packages.map((pkg) => (pkg === "docx" ? "python-docx" : pkg))
  return `${shellQuote(pythonExecutable)} -m pip install ${pipPackages.join(" ")}`
}

export function checkPythonPackages(
  pythonExecutable: string,
  packages: readonly string[] = [...REQUIRED_PYTHON_PACKAGES],
): PythonPackageReport {
  const checks = packages.map((pkg) => {
    if (pkg === "python-docx" || pkg === "docx") {
      return {
        package: "python-docx",
        module: "docx",
        documentClass: true,
      }
    }
    return {
      package: pkg,
      module: pkg,
      documentClass: false,
    }
  })
  const script = [
    "import importlib, importlib.util, json",
    `checks = json.loads(${JSON.stringify(JSON.stringify(checks))})`,
    "missing = []",
    "for item in checks:",
    "    try:",
    "        if importlib.util.find_spec(item['module']) is None:",
    "            raise ImportError('module is unavailable')",
    "        if item.get('documentClass'):",
    "            module = importlib.import_module(item['module'])",
    "            if not hasattr(module, 'Document'):",
    "                raise ImportError('python-docx Document class is unavailable')",
    "    except Exception:",
    "        missing.append(item['package'])",
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

type UvReleaseAsset = {
  archive: string
  executable: string
  compressed: "zip" | "tar.gz"
}

export function uvReleaseAsset(input = { platform: process.platform, arch: process.arch }): UvReleaseAsset | undefined {
  const architecture = input.arch === "arm64" ? "aarch64" : input.arch === "x64" ? "x86_64" : undefined
  if (!architecture) return undefined

  if (input.platform === "win32") {
    return {
      archive: `uv-${architecture}-pc-windows-msvc.zip`,
      executable: "uv.exe",
      compressed: "zip",
    }
  }

  if (input.platform === "darwin") {
    return {
      archive: `uv-${architecture}-apple-darwin.tar.gz`,
      executable: "uv",
      compressed: "tar.gz",
    }
  }

  if (input.platform === "linux") {
    return {
      archive: `uv-${architecture}-unknown-linux-gnu.tar.gz`,
      executable: "uv",
      compressed: "tar.gz",
    }
  }
}

function releaseUrl(asset: UvReleaseAsset) {
  return `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset.archive}`
}

async function downloadVerifiedFile(url: string, destination: string) {
  const [archiveResponse, checksumResponse] = await Promise.all([
    fetch(url, { signal: AbortSignal.timeout(120_000) }),
    fetch(`${url}.sha256`, { signal: AbortSignal.timeout(30_000) }),
  ])
  if (!archiveResponse.ok) throw new Error(`Unable to download the analysis runtime (${archiveResponse.status}).`)
  if (!checksumResponse.ok) throw new Error(`Unable to verify the analysis runtime download (${checksumResponse.status}).`)

  const expected = (await checksumResponse.text()).trim().split(/\s+/)[0]?.toLowerCase()
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("The analysis runtime checksum was invalid.")

  const bytes = Buffer.from(await archiveResponse.arrayBuffer())
  const actual = crypto.createHash("sha256").update(bytes).digest("hex")
  if (actual !== expected) throw new Error("The analysis runtime download did not pass verification.")

  fs.writeFileSync(destination, bytes)
}

function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function findFile(root: string, filename: string): string | undefined {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isFile() && entry.name === filename) return candidate
    if (entry.isDirectory()) {
      const nested = findFile(candidate, filename)
      if (nested) return nested
    }
  }
}

function extractUvArchive(input: { archive: string; destination: string; compressed: UvReleaseAsset["compressed"] }) {
  const result =
    input.compressed === "zip"
      ? runProcess("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath ${quotePowerShell(input.archive)} -DestinationPath ${quotePowerShell(input.destination)} -Force`,
        ])
      : runProcess("tar", ["-xzf", input.archive, "-C", input.destination])

  if (result.status !== 0) {
    throw new Error((`${result.stdout}\n${result.stderr}`).trim() || "Unable to unpack the analysis runtime.")
  }
}

async function ensureManagedUv() {
  const executable = managedUvExecutable()
  if (fs.existsSync(executable)) return executable

  const asset = uvReleaseAsset()
  if (!asset) throw new Error(`Automatic data-engine setup is not available for ${process.platform}/${process.arch}.`)

  const root = managedUvRoot()
  const archive = path.join(root, `uv-${UV_VERSION}.${asset.compressed === "zip" ? "zip" : "tar.gz"}`)
  const extraction = path.join(root, "extract")
  fs.mkdirSync(root, { recursive: true })
  fs.rmSync(extraction, { recursive: true, force: true })
  fs.mkdirSync(extraction, { recursive: true })

  try {
    await downloadVerifiedFile(releaseUrl(asset), archive)
    extractUvArchive({ archive, destination: extraction, compressed: asset.compressed })
    const extracted = findFile(extraction, asset.executable)
    if (!extracted) throw new Error("The downloaded analysis runtime did not contain its executable.")
    fs.copyFileSync(extracted, executable)
    if (process.platform !== "win32") fs.chmodSync(executable, 0o755)
    return executable
  } finally {
    fs.rmSync(archive, { force: true })
    fs.rmSync(extraction, { recursive: true, force: true })
  }
}

function managedRuntimeEnvironment(): NodeJS.ProcessEnv {
  return {
    UV_NO_MODIFY_PATH: "1",
    UV_PYTHON_INSTALL_DIR: managedPythonInstallRoot(),
    UV_CACHE_DIR: path.join(managedRuntimeRoot(), "cache"),
  }
}

function runUv(uv: string, args: string[]) {
  const result = runProcess(uv, args, managedRuntimeEnvironment())
  if (result.status !== 0) {
    throw new Error((`${result.stdout}\n${result.stderr}`).trim() || "Unable to prepare the data analysis environment.")
  }
}

async function hasExplicitPythonOverride() {
  if (process.env.KILLSTATA_PYTHON?.trim()) return true
  const config = await Config.get()
  return Boolean(config.killstata?.python?.executable?.trim())
}

let managedRuntimeProvision: Promise<RuntimePythonStatus> | undefined

async function provisionManagedRuntime(packages: readonly string[]): Promise<RuntimePythonStatus> {
  const uv = await ensureManagedUv()
  const executable = managedPythonExecutable()

  if (!fs.existsSync(executable)) {
    fs.rmSync(managedPythonVenvRoot(), { recursive: true, force: true })
    runUv(uv, ["venv", "--python", MANAGED_PYTHON_VERSION, "--managed-python", managedPythonVenvRoot()])
  }

  const report = checkPythonPackages(executable, packages)
  if (report.missing.length > 0) {
    runUv(uv, ["pip", "install", "--python", executable, "--upgrade", ...report.missing])
  }

  return getRuntimePythonStatus([...packages])
}

/**
 * Creates and repairs KillStata's private data-analysis runtime. User supplied
 * Python overrides remain available for advanced use, but the normal path never
 * writes to or modifies a system Python installation.
 */
export async function ensureRuntimePythonReady(packages: readonly string[] = [...REQUIRED_PYTHON_PACKAGES]) {
  if (process.env.KILLSTATA_DISABLE_AUTO_RUNTIME === "true") return getRuntimePythonStatus([...packages])
  if (await hasExplicitPythonOverride()) return getRuntimePythonStatus([...packages])

  const current = await getRuntimePythonStatus([...packages])
  if (current.source === "managed" && current.ok && current.missing.length === 0) return current

  if (!managedRuntimeProvision) {
    managedRuntimeProvision = provisionManagedRuntime(packages).finally(() => {
      managedRuntimeProvision = undefined
    })
  }
  return managedRuntimeProvision
}

export async function getRuntimePythonStatus(
  packages: readonly string[] = [...REQUIRED_PYTHON_PACKAGES],
): Promise<RuntimePythonStatus> {
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
    "KillStata could not prepare its data-analysis engine automatically.",
    "Please check your network connection and try the analysis again.",
  ]

  if (!status.ok && status.error) lines.push(`Technical detail: ${status.error}`)
  else if (status.missing.length) lines.push(`Technical detail: required analysis components are unavailable.`)

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

  if (fs.existsSync(paths.legacySkillRoot) && fs.existsSync(paths.skillRoot)) {
    for (const entry of fs.readdirSync(paths.legacySkillRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const source = path.join(paths.legacySkillRoot, entry.name)
      const target = path.join(paths.skillRoot, entry.name)
      if (fs.existsSync(target)) continue
      fs.renameSync(source, target)
    }
    if (fs.readdirSync(paths.legacySkillRoot).length === 0) {
      fs.rmSync(paths.legacySkillRoot, { recursive: true, force: true })
    }
  }

  const legacySkillRoots = [paths.defaultSkills, paths.importedSkills, paths.localSkills]
  for (const legacyRoot of legacySkillRoots) {
    if (!fs.existsSync(legacyRoot)) continue
    for (const entry of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const source = path.join(legacyRoot, entry.name)
      const target = path.join(paths.skillRoot, entry.name)
      if (fs.existsSync(target)) continue
      fs.renameSync(source, target)
    }
    const leftovers = fs.readdirSync(legacyRoot)
    if (leftovers.length === 0) {
      fs.rmSync(legacyRoot, { recursive: true, force: true })
    }
  }

  const directories = [
    paths.managedPythonVenv,
    paths.workspace,
    paths.agents,
    paths.mainAgentRoot,
    paths.mainAgentState,
    paths.mainAgentSessions,
    paths.subagents,
    paths.logs,
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
