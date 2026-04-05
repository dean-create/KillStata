import fs from "fs"
import path from "path"
import z from "zod"
import { Config } from "../config/config"
import { Global } from "../global"
import { managedStataMcpRoot } from "@/killstata/runtime-config"

export const StataEdition = z.enum(["mp", "se", "be"])
export type StataEdition = z.infer<typeof StataEdition>

const PACKAGE_ROOT = path.resolve(import.meta.dir, "../..")
const SOURCE_ENTRY = path.resolve(import.meta.dir, "../stata-mcp-server.ts")
const PYTHON_SERVER = path.join(PACKAGE_ROOT, "python", "stata_mcp", "server.py")

function stripOuterQuotes(value: string) {
  return value.trim().replace(/^["']|["']$/g, "")
}

export function normalizeStataPath(input: string) {
  const trimmed = stripOuterQuotes(input)
  if (!trimmed) {
    throw new Error("Stata path is required.")
  }
  return path.resolve(path.normalize(trimmed))
}

export function stataMcpHome() {
  const configured = process.env["KILLSTATA_STATA_MCP_HOME"]
  if (configured) return normalizeStataPath(configured)
  return managedStataMcpRoot()
}

function stataMcpVenv() {
  return path.join(stataMcpHome(), "venv")
}

export function bundledStataServerScript() {
  return PYTHON_SERVER
}

function bundledCommandViaBun() {
  return [process.execPath, "run", "--conditions=browser", SOURCE_ENTRY]
}

export function bundledStataServerCommand() {
  if (process.env.KILLSTATA_BIN_PATH) {
    return [process.env.KILLSTATA_BIN_PATH, "mcp", "stata-server"]
  }

  if (process.versions.bun && fs.existsSync(SOURCE_ENTRY)) {
    return bundledCommandViaBun()
  }

  return ["killstata-stata-mcp"]
}

function discoverSystemPythonPath() {
  return resolveCommand("python") ?? resolveCommand("python3")
}

export function createBuiltInStataMcpConfig(stataPath: string, edition: StataEdition): Config.Mcp {
  const normalizedPath = normalizeStataPath(stataPath)
  const pythonPath = discoverSystemPythonPath()

  return {
    type: "local",
    command: bundledStataServerCommand(),
    environment: {
      STATA_PATH: normalizedPath,
      STATA_EDITION: edition,
      KILLSTATA_STATA_MCP_HOME: stataMcpHome(),
      ...(pythonPath ? { KILLSTATA_PYTHON: pythonPath } : {}),
    },
    timeout: 120_000,
  }
}

function resolveVenvPython() {
  return process.platform === "win32"
    ? path.join(stataMcpVenv(), "Scripts", "python.exe")
    : path.join(stataMcpVenv(), "bin", "python")
}

function commandExists(command: string) {
  return Bun.which(command) !== null
}

function resolveCommand(command: string) {
  if (path.isAbsolute(command)) return command
  const direct = Bun.which(command)
  if (direct) return direct
  if (process.platform !== "win32") return undefined

  try {
    const proc = Bun.spawnSync(["where.exe", command], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    if (proc.exitCode !== 0) return undefined
    const match = proc.stdout
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    return match || undefined
  } catch {
    return undefined
  }
}

function spawnSyncOrThrow(command: string, args: string[]) {
  const proc = Bun.spawnSync([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PYTHONUTF8: "1",
    },
  })

  if (proc.exitCode === 0) return proc

  const stdout = proc.stdout.toString()
  const stderr = proc.stderr.toString()
  const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
  throw new Error(detail || `Command failed: ${command} ${args.join(" ")}`)
}

function findSystemPython() {
  const override = process.env["KILLSTATA_PYTHON"]
  if (override) {
    return { command: normalizeStataPath(override), args: [] as string[] }
  }

  const candidates: Array<{ command: string; args: string[] }> = process.platform === "win32"
    ? [
        { command: "python", args: [] },
        { command: "python3", args: [] },
        { command: "py", args: ["-3"] },
      ]
    : [
        { command: "python3", args: [] },
        { command: "python", args: [] },
      ]

  for (const candidate of candidates) {
    const resolved = resolveCommand(candidate.command)
    if (!resolved) continue
    try {
      const proc = Bun.spawnSync([resolved, ...candidate.args, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      })
      if (proc.exitCode === 0) return { ...candidate, command: resolved }
    } catch {
      continue
    }
  }

  throw new Error(
    "Python was not found. Install Python 3.9+ and ensure `python`, `python3`, or `py -3` is available on PATH.",
  )
}

function ensureVenv(systemPython: { command: string; args: string[] }) {
  const venvPython = resolveVenvPython()
  if (fs.existsSync(venvPython)) return venvPython

  const home = stataMcpHome()
  fs.mkdirSync(home, { recursive: true })

  const uv = Bun.which("uv")
  if (uv) {
    try {
      spawnSyncOrThrow(uv, ["venv", stataMcpVenv(), "--python", systemPython.command])
      if (fs.existsSync(venvPython)) return venvPython
    } catch {
      // Fall back to python -m venv below.
    }
  }

  spawnSyncOrThrow(systemPython.command, [...systemPython.args, "-m", "venv", stataMcpVenv()])
  if (!fs.existsSync(venvPython)) {
    throw new Error(`Failed to create Python virtual environment at ${stataMcpVenv()}`)
  }

  return venvPython
}

function assertBundledServerReady() {
  if (!fs.existsSync(PYTHON_SERVER)) {
    throw new Error(`Bundled Stata MCP server was not found at ${PYTHON_SERVER}`)
  }

  const stataPath = process.env["STATA_PATH"]
  if (!stataPath) {
    throw new Error("STATA_PATH is not set. Configure the built-in Stata MCP with `killstata mcp add`.")
  }

  const normalized = normalizeStataPath(stataPath)
  if (!fs.existsSync(normalized)) {
    throw new Error(`Configured STATA_PATH does not exist: ${normalized}`)
  }

  process.env["STATA_PATH"] = normalized
  process.env["STATA_EDITION"] = StataEdition.parse((process.env["STATA_EDITION"] ?? "mp").toLowerCase())
  process.env["KILLSTATA_STATA_MCP_HOME"] = process.env["KILLSTATA_STATA_MCP_HOME"] ?? stataMcpHome()
}

export async function runBundledStataMcpServer() {
  assertBundledServerReady()

  const python = ensureVenv(findSystemPython())
  const child = Bun.spawn([python, bundledStataServerScript()], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      PYTHONUTF8: "1",
    },
  })

  const code = await child.exited
  if (code !== 0) {
    throw new Error(`Bundled Stata MCP server exited with code ${code}`)
  }
}
