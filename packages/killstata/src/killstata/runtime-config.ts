import { Env } from "@/env"
import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"
import { spawn, spawnSync } from "child_process"
import { Database } from "bun:sqlite"
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError as JsoncParseError,
} from "jsonc-parser"
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

export type RuntimePythonSelectionInputs = {
  environmentOverride?: string
  configOverride?: string
  managedExecutable?: string
  preferredExecutable?: string
  systemExecutable?: string
  defaultExecutable: string
}

export type RuntimePythonStatus = RuntimePythonSelection & {
  version?: string
  ok: boolean
  error?: string
  missing: string[]
  installCommand: string
}

const WINDOWS_PREFERRED_PYTHON_CANDIDATES = ["D:\\anaconda3\\envs\\trae_agent\\python.exe"]

export const REQUIRED_PYTHON_PACKAGES = [
  "pydantic",
  "pandas",
  "numpy",
  "scipy",
  "statsmodels",
  "linearmodels",
  "matplotlib",
  "openpyxl",
  "pyarrow",
  // KNN、缩放与 PowerTransformer 是 data_preprocess 的唯一算法核心的一部分，
  // 不能依赖用户环境里恰好已安装 sklearn。
  "scikit-learn",
  "python-docx",
  "pyfixest",
  "rdrobust",
] as const

export const PYFIXEST_VERSION = "0.60.0"
export const RDROBUST_VERSION = "2.0.0"
export const PYDANTIC_VERSION = "2.13.2"

const PYTHON_PACKAGE_INSTALL_SPECS: Readonly<Record<string, string>> = {
  docx: "python-docx",
  "python-docx": "python-docx",
  pyfixest: `pyfixest==${PYFIXEST_VERSION}`,
  pydantic: `pydantic==${PYDANTIC_VERSION}`,
  // rdrobust 没有 __version__ 属性，不做运行时版本校验（避免误判缺失），仅在安装时 pin。
  rdrobust: `rdrobust==${RDROBUST_VERSION}`,
}

export function pythonPackageInstallSpecs(packages: readonly string[]) {
  return packages.map((pkg) => PYTHON_PACKAGE_INSTALL_SPECS[pkg] ?? pkg)
}

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

/** 返回引擎包根目录；源码、发布包和开发工作目录分别使用不同候选路径。 */
export function econometricsEngineRoot() {
  const override = process.env.KILLSTATA_ENGINE_ROOT?.trim()
  const candidates = [
    override,
    path.resolve(import.meta.dir, "../../../killstata-econometrics-engine"),
    path.resolve(import.meta.dir, "../../../engine"),
    path.resolve(path.dirname(process.execPath), "engine"),
    path.resolve(path.dirname(process.execPath), "../engine"),
  ].filter((value): value is string => Boolean(value))
  return candidates.find((value) => fs.existsSync(path.join(value, "src", "killstata_econometrics_engine"))) ?? candidates[0]
}

export function econometricsEngineRequirementsPath() {
  return path.join(econometricsEngineRoot(), "requirements.lock")
}

export function userSkillRoot() {
  return path.join(userRoot(), "skills")
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
    skillRoot: userSkillRoot(),
  }
}

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

export type AsyncProcessOptions = { timeoutMs?: number; maxOutputBytes?: number }

const RUNTIME_PROBE_TIMEOUT_MS = 30_000
const RUNTIME_INSTALL_TIMEOUT_MS = 20 * 60_000
// Managed setup allows three 20-minute subprocesses, five 30-second probes/checks, and a bounded download.
const RUNTIME_INSTALL_LOCK_WAIT_MS = 70 * 60_000
const MAX_RUNTIME_PROCESS_OUTPUT_BYTES = 1024 * 1024

function signalProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    })
    const fallback = () => { child.kill(signal) }
    killer.once("error", fallback)
    killer.once("close", (status) => { if (status !== 0) fallback() })
    killer.unref()
    return
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {}
  }
  child.kill(signal)
}

/** Run Python/uv without blocking the Core request and event loop. */
export function runProcessAsync(
  command: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  options: AsyncProcessOptions = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? RUNTIME_PROBE_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? MAX_RUNTIME_PROCESS_OUTPUT_BYTES
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("运行环境子进程超时设置无效")
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 0) throw new Error("运行环境子进程输出上限无效")

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        ...extraEnv,
      },
      detached: process.platform !== "win32",
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined

    const clearTimers = () => {
      clearTimeout(timeoutTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimers()
      reject(error)
    }
    const capture = (target: Buffer[], currentBytes: number, chunk: Buffer) => {
      const remaining = maxOutputBytes - currentBytes
      if (remaining <= 0) return currentBytes
      const bounded = chunk.subarray(0, remaining)
      target.push(bounded)
      return currentBytes + bounded.byteLength
    }

    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = capture(stdout, stdoutBytes, chunk) })
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes = capture(stderr, stderrBytes, chunk) })
    child.once("error", fail)
    child.once("close", (status) => {
      if (settled) return
      settled = true
      clearTimers()
      if (timedOut) {
        reject(new Error(`运行环境子进程超时（${Math.ceil(timeoutMs / 1_000)} 秒）`))
        return
      }
      resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })
    })

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      signalProcessTree(child, "SIGTERM")
      forceKillTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), 1_000)
    }, timeoutMs)
  })
}

function isSqliteBusy(error: unknown) {
  const candidate = error as { code?: unknown; message?: unknown }
  const code = typeof candidate?.code === "string" ? candidate.code : ""
  const message = typeof candidate?.message === "string" ? candidate.message : String(error)
  return code.includes("BUSY") || code.includes("LOCKED") || /database is locked/i.test(message)
}

/** Serialize Python environment mutation across both the CLI and Desktop processes. */
export async function withRuntimePythonInstallLock<T>(pythonExecutable: string, operation: () => Promise<T>): Promise<T> {
  const requestedTarget = path.resolve(pythonExecutable)
  const physicalTarget = await fs.promises.realpath(requestedTarget).catch(() => requestedTarget)
  const lockKeys = [...new Set([requestedTarget, physicalTarget].map((target) =>
    process.platform === "win32" ? target.toLowerCase() : target,
  ))].sort()
  const lockDirectory = path.join(userRoot(), "runtime-install-locks")
  await fs.promises.mkdir(lockDirectory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await fs.promises.chmod(lockDirectory, 0o700)
  const databases: Array<{ database: Database; locked: boolean }> = []
  const deadline = Date.now() + RUNTIME_INSTALL_LOCK_WAIT_MS
  try {
    for (const lockKey of lockKeys) {
      const lockPath = path.join(lockDirectory, `${crypto.createHash("sha256").update(lockKey).digest("hex")}.sqlite`)
      const entry = { database: new Database(lockPath, { create: true }), locked: false }
      databases.push(entry)
      entry.database.exec("PRAGMA busy_timeout = 0")
      while (true) {
        try {
          entry.database.exec("BEGIN EXCLUSIVE")
          entry.locked = true
          break
        } catch (error) {
          if (!isSqliteBusy(error)) throw error
          if (Date.now() >= deadline) throw new Error("另一个 KillStata 进程正在准备相同的 Python 环境，请稍后重试。")
          await Bun.sleep(200)
        }
      }
    }
    return await operation()
  } finally {
    const cleanupErrors: unknown[] = []
    for (const entry of databases.reverse()) {
      try {
        if (entry.locked) entry.database.exec("ROLLBACK")
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        entry.database.close()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) throw cleanupErrors[0]
  }
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

async function resolveCommandAsync(command: string) {
  if (path.isAbsolute(command)) return command
  const direct = Bun.which(command)
  if (direct) return direct
  if (process.platform !== "win32") return undefined
  try {
    const proc = await runProcessAsync("where.exe", [command], {}, { timeoutMs: 5_000 })
    if (proc.status !== 0) return undefined
    return proc.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  } catch {
    return undefined
  }
}

async function probePythonExecutableAsync(command: string): Promise<PythonProbe> {
  const resolved = await resolveCommandAsync(command) ?? command
  try {
    const proc = await runProcessAsync(resolved, ["--version"], {}, { timeoutMs: RUNTIME_PROBE_TIMEOUT_MS })
    const output = `${proc.stdout}\n${proc.stderr}`.trim()
    if (proc.status !== 0) return { command, resolved, ok: false, error: output || `Exit code ${proc.status}` }
    return { command, resolved, ok: true, version: output.split(/\r?\n/).find(Boolean)?.trim() }
  } catch (error) {
    return { command, resolved, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function discoverSystemPython(): PythonProbe | undefined {
  const candidates = process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"]

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

async function discoverSystemPythonAsync(): Promise<PythonProbe | undefined> {
  const candidates = process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"]

  for (const candidate of candidates) {
    const args = candidate === "py" ? ["-3", "--version"] : ["--version"]
    const resolved = await resolveCommandAsync(candidate)
    if (!resolved) continue
    try {
      const proc = await runProcessAsync(resolved, args, {}, { timeoutMs: RUNTIME_PROBE_TIMEOUT_MS })
      const output = `${proc.stdout}\n${proc.stderr}`.trim()
      if (proc.status === 0) {
        return { command: candidate, resolved, ok: true, version: output.split(/\r?\n/).find(Boolean)?.trim() }
      }
    } catch {
      continue
    }
  }
}

export function selectRuntimePythonSelection(input: RuntimePythonSelectionInputs): RuntimePythonSelection {
  if (input.environmentOverride) return { executable: input.environmentOverride, source: "env" }
  if (input.configOverride) return { executable: input.configOverride, source: "config" }
  if (input.managedExecutable) return { executable: input.managedExecutable, source: "managed" }
  if (input.preferredExecutable) return { executable: input.preferredExecutable, source: "trae_agent" }
  if (input.systemExecutable) return { executable: input.systemExecutable, source: "system" }
  return { executable: input.defaultExecutable, source: "default" }
}

export async function resolveRuntimePythonSelection(): Promise<RuntimePythonSelection> {
  const environmentOverride = Env.get("KILLSTATA_PYTHON")?.trim()
  if (environmentOverride) {
    return selectRuntimePythonSelection({ environmentOverride, defaultExecutable: defaultPythonCommand() })
  }

  const config = await Config.get()
  const configOverride = config.killstata?.python?.executable?.trim()
  const managedExecutable = fs.existsSync(managedPythonExecutable()) ? managedPythonExecutable() : undefined
  const preferredExecutable = preferredLocalPythonExecutable()
  const candidates = { configOverride, managedExecutable, preferredExecutable, defaultExecutable: defaultPythonCommand() }
  const preferred = selectRuntimePythonSelection(candidates)
  if (preferred.source !== "default") return preferred

  const systemExecutable = (await discoverSystemPythonAsync())?.resolved
  return selectRuntimePythonSelection({ ...candidates, systemExecutable })
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
  const pipPackages = pythonPackageInstallSpecs(packages)
  return `${shellQuote(pythonExecutable)} -m pip install ${pipPackages.join(" ")}`
}

export function checkPythonPackages(
  pythonExecutable: string,
  packages: readonly string[] = [...REQUIRED_PYTHON_PACKAGES],
): PythonPackageReport {
  const proc = runProcess(pythonExecutable, ["-c", packageCheckScript(packages)])
  if (proc.status !== 0) {
    throw new Error(`${proc.stdout}\n${proc.stderr}`.trim() || `Failed to inspect packages with ${pythonExecutable}`)
  }

  const parsed = JSON.parse(proc.stdout.trim() || "{}") as { missing?: string[] }
  return {
    checkedWith: pythonExecutable,
    missing: parsed.missing ?? [],
  }
}

function packageCheckScript(packages: readonly string[]) {
  const checks = packages.map((pkg) => {
    if (pkg === "python-docx" || pkg === "docx") return { package: "python-docx", module: "docx", documentClass: true }
    if (pkg === "scikit-learn") return { package: pkg, module: "sklearn", documentClass: false }
    return { package: pkg, module: pkg, documentClass: false, expectedVersion: pkg === "pyfixest" ? PYFIXEST_VERSION : undefined }
  })
  return [
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
    "        if item.get('expectedVersion'):",
    "            module = importlib.import_module(item['module'])",
    "            if getattr(module, '__version__', None) != item['expectedVersion']:",
    "                raise ImportError('package version is incompatible')",
    "    except Exception:",
    "        missing.append(item['package'])",
    "print(json.dumps({'missing': missing}))",
  ].join("\n")
}

async function checkPythonPackagesAsync(
  pythonExecutable: string,
  packages: readonly string[] = [...REQUIRED_PYTHON_PACKAGES],
): Promise<PythonPackageReport> {
  const proc = await runProcessAsync(pythonExecutable, ["-c", packageCheckScript(packages)], {}, { timeoutMs: RUNTIME_PROBE_TIMEOUT_MS })
  if (proc.status !== 0) {
    throw new Error(`${proc.stdout}\n${proc.stderr}`.trim() || `Failed to inspect packages with ${pythonExecutable}`)
  }
  const parsed = JSON.parse(proc.stdout.trim() || "{}") as { missing?: string[] }
  return { checkedWith: pythonExecutable, missing: parsed.missing ?? [] }
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
  if (!checksumResponse.ok)
    throw new Error(`Unable to verify the analysis runtime download (${checksumResponse.status}).`)

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

async function extractUvArchive(input: { archive: string; destination: string; compressed: UvReleaseAsset["compressed"] }) {
  const result = await runProcessAsync(
    input.compressed === "zip" ? "powershell.exe" : "tar",
    input.compressed === "zip"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath ${quotePowerShell(input.archive)} -DestinationPath ${quotePowerShell(input.destination)} -Force`,
        ]
      : ["-xzf", input.archive, "-C", input.destination],
    {},
    { timeoutMs: RUNTIME_INSTALL_TIMEOUT_MS },
  )

  if (result.status !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`.trim() || "Unable to unpack the analysis runtime.")
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
  await fs.promises.mkdir(root, { recursive: true })
  await fs.promises.rm(extraction, { recursive: true, force: true })
  await fs.promises.mkdir(extraction, { recursive: true })

  try {
    await downloadVerifiedFile(releaseUrl(asset), archive)
    await extractUvArchive({ archive, destination: extraction, compressed: asset.compressed })
    const extracted = findFile(extraction, asset.executable)
    if (!extracted) throw new Error("The downloaded analysis runtime did not contain its executable.")
    await fs.promises.copyFile(extracted, executable)
    if (process.platform !== "win32") await fs.promises.chmod(executable, 0o755)
    return executable
  } finally {
    await fs.promises.rm(archive, { force: true })
    await fs.promises.rm(extraction, { recursive: true, force: true })
  }
}

function managedRuntimeEnvironment(): NodeJS.ProcessEnv {
  return {
    UV_NO_MODIFY_PATH: "1",
    UV_PYTHON_INSTALL_DIR: managedPythonInstallRoot(),
    UV_CACHE_DIR: path.join(managedRuntimeRoot(), "cache"),
  }
}

async function runUv(uv: string, args: string[]) {
  const result = await runProcessAsync(uv, args, managedRuntimeEnvironment(), { timeoutMs: RUNTIME_INSTALL_TIMEOUT_MS })
  if (result.status !== 0) {
    throw new Error(`${result.stdout}\n${result.stderr}`.trim() || "Unable to prepare the data analysis environment.")
  }
}

let managedRuntimeProvision: Promise<RuntimePythonStatus> | undefined

async function provisionManagedRuntime(packages: readonly string[]): Promise<RuntimePythonStatus> {
  const uv = await ensureManagedUv()
  const executable = managedPythonExecutable()

  if (!fs.existsSync(executable)) {
    await fs.promises.rm(managedPythonVenvRoot(), { recursive: true, force: true })
    await runUv(uv, ["venv", "--python", MANAGED_PYTHON_VERSION, "--managed-python", managedPythonVenvRoot()])
  }

  const report = await checkPythonPackagesAsync(executable, packages)
  if (report.missing.length > 0) {
    const lockfile = econometricsEngineRequirementsPath()
    if (fs.existsSync(lockfile)) {
      await runUv(uv, ["pip", "install", "--python", executable, "--upgrade", "-r", lockfile])
    } else {
      await runUv(uv, ["pip", "install", "--python", executable, "--upgrade", ...pythonPackageInstallSpecs(report.missing)])
    }
  }

  return getRuntimePythonStatus([...packages])
}

/**
 * Creates and repairs KillStata's private data-analysis runtime. User supplied
 * Python overrides remain available for advanced use, but the normal path never
 * writes to or modifies a system Python installation.
 */
export async function ensureRuntimePythonReady(packages: readonly string[] = [...REQUIRED_PYTHON_PACKAGES]) {
  if (Env.get("KILLSTATA_DISABLE_AUTO_RUNTIME") === "true") return getRuntimePythonStatus([...packages])

  const current = await getRuntimePythonStatus([...packages])
  if (current.source === "env" || current.source === "config") return current
  if (current.source === "managed" && current.ok && current.missing.length === 0) return current

  if (!managedRuntimeProvision) {
    managedRuntimeProvision = withRuntimePythonInstallLock(managedPythonExecutable(), () => provisionManagedRuntime(packages)).finally(() => {
      managedRuntimeProvision = undefined
    })
  }
  return managedRuntimeProvision
}

export async function getRuntimePythonStatus(
  packages: readonly string[] = [...REQUIRED_PYTHON_PACKAGES],
): Promise<RuntimePythonStatus> {
  const selection = await resolveRuntimePythonSelection()
  const probe = await probePythonExecutableAsync(selection.executable)
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
    const report = await checkPythonPackagesAsync(executable, packages)
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
  // 只在"环境本身健康、仅缺依赖包"时给出可操作的安装指引；探测/网络失败等
  // 无法定位到具体包的情形保持原有通用文案，不把英文技术细节透给用户。
  if (status.ok && status.missing.length > 0) {
    return (
      `${toolName} 需要的数据分析环境不完整：缺少依赖包 ${status.missing.join("、")}。` +
      (status.installCommand ? `可执行：${status.installCommand}。` : "请检查网络连接后重试当前分析。")
    )
  }
  return "KillStata 没能自动准备数据分析环境。请检查网络连接后重试当前分析。"
}

export function ensureManagedPythonVenv(pythonExecutable: string) {
  fs.mkdirSync(userRoot(), { recursive: true })
  if (fs.existsSync(managedPythonExecutable())) return managedPythonExecutable()

  const proc = runProcess(pythonExecutable, ["-m", "venv", managedPythonVenvRoot()])
  if (proc.status !== 0 || !fs.existsSync(managedPythonExecutable())) {
    throw new Error(`${proc.stdout}\n${proc.stderr}`.trim() || "Failed to create managed Python virtual environment")
  }
  return managedPythonExecutable()
}

export function installPythonPackages(pythonExecutable: string, packages = [...REQUIRED_PYTHON_PACKAGES]) {
  const upgradePip = runProcess(pythonExecutable, ["-m", "pip", "install", "--upgrade", "pip"])
  if (upgradePip.status !== 0) {
    throw new Error(`${upgradePip.stdout}\n${upgradePip.stderr}`.trim() || "Failed to upgrade pip")
  }

  const install = runProcess(pythonExecutable, ["-m", "pip", "install", ...pythonPackageInstallSpecs(packages)])
  if (install.status !== 0) {
    throw new Error(`${install.stdout}\n${install.stderr}`.trim() || "Failed to install Python packages")
  }
}

export async function installPythonPackagesAsync(pythonExecutable: string, packages = [...REQUIRED_PYTHON_PACKAGES]) {
  return await withRuntimePythonInstallLock(pythonExecutable, async () => {
    const current = await checkPythonPackagesAsync(pythonExecutable, packages)
    if (current.missing.length === 0) return
    const upgradePip = await runProcessAsync(
      pythonExecutable,
      ["-m", "pip", "install", "--upgrade", "pip"],
      {},
      { timeoutMs: RUNTIME_INSTALL_TIMEOUT_MS },
    )
    if (upgradePip.status !== 0) {
      throw new Error(`${upgradePip.stdout}\n${upgradePip.stderr}`.trim() || "Failed to upgrade pip")
    }

    const install = await runProcessAsync(
      pythonExecutable,
      ["-m", "pip", "install", ...pythonPackageInstallSpecs(current.missing)],
      {},
      { timeoutMs: RUNTIME_INSTALL_TIMEOUT_MS },
    )
    if (install.status !== 0) {
      throw new Error(`${install.stdout}\n${install.stderr}`.trim() || "Failed to install Python packages")
    }
  })
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
  let text = await Bun.file(filepath)
    .text()
    .catch(() => "")
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

export async function ensureKillstataHomeDirectories() {
  const paths = userPaths()
  fs.mkdirSync(paths.root, { recursive: true })
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
