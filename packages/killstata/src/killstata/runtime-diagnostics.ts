import path from "node:path"
import {
  ensureRuntimePythonReady,
  getRuntimePythonStatus,
  installPythonPackagesAsync,
  managedPythonExecutable,
  REQUIRED_PYTHON_PACKAGES,
  type RuntimePythonStatus,
} from "./runtime-config"

export type RuntimeDiagnosticStatus = "ready" | "warning" | "error"

export type RuntimeDiagnosticCheck = {
  label: string
  status: RuntimeDiagnosticStatus
  detail: string
  suggestion: string
}

export type RuntimeDiagnosticsReport = {
  python: RuntimeDiagnosticCheck
  packages: RuntimeDiagnosticCheck[]
}

type RequiredPythonPackage = typeof REQUIRED_PYTHON_PACKAGES[number]

export type RuntimeDiagnosticsDependencies = {
  getStatus(packages: readonly string[]): Promise<RuntimePythonStatus>
  ensureRuntimePythonReady(packages: readonly string[]): Promise<RuntimePythonStatus>
  installPythonPackages(executable: string, packages: RequiredPythonPackage[]): Promise<void>
}

const runtimeInstallQueues = new Map<string, Promise<void>>()

function runtimeInstallTargetKey(status: RuntimePythonStatus) {
  const target = status.source === "env" || status.source === "config" || status.source === "managed"
    ? status.executable
    : managedPythonExecutable()
  const executable = path.resolve(target)
  return `configured:${process.platform === "win32" ? executable.toLowerCase() : executable}`
}

async function withRuntimeInstallLock<T>(target: string, operation: () => Promise<T>) {
  const previous = runtimeInstallQueues.get(target) ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.catch(() => undefined).then(() => turn)
  runtimeInstallQueues.set(target, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    void tail.then(() => {
      if (runtimeInstallQueues.get(target) === tail) runtimeInstallQueues.delete(target)
    })
  }
}

const defaultDependencies: RuntimeDiagnosticsDependencies = {
  getStatus: getRuntimePythonStatus,
  ensureRuntimePythonReady,
  installPythonPackages: installPythonPackagesAsync,
}

function sourceLabel(source: string) {
  switch (source) {
    case "env": return "环境变量指定"
    case "config": return "KillStata 配置指定"
    case "managed": return "KillStata 受管环境"
    case "trae_agent": return "本机 trae_agent 环境"
    case "system": return "系统 Python"
    default: return "默认 Python 命令"
  }
}

export function runtimeReportFromStatus(status: RuntimePythonStatus): RuntimeDiagnosticsReport {
  const missing = new Set(status.missing)
  const python: RuntimeDiagnosticCheck = {
    label: "Python 解释器",
    status: !status.ok ? "error" : missing.size ? "warning" : "ready",
    detail: status.ok
      ? `${status.version ?? "Python"} · ${status.executable} · ${sourceLabel(status.source)}`
      : "未检测到可运行的 Python 解释器。",
    suggestion: !status.ok
      ? "请检查本机 Python 配置后重试。"
      : missing.size ? "确认安装缺失的固定分析依赖。" : "",
  }
  const packages = REQUIRED_PYTHON_PACKAGES.map((name) => ({
    label: name,
    status: !status.ok ? "error" as const : missing.has(name) ? "warning" as const : "ready" as const,
    detail: !status.ok ? "需要先检测到 Python 才能检查。" : missing.has(name) ? "未安装或无法读取。" : "已安装。",
    suggestion: !status.ok || missing.has(name) ? "此项属于 KillStata 固定分析依赖。" : "",
  }))
  return { python, packages }
}

export function createRuntimeDiagnostics(dependencies: Partial<RuntimeDiagnosticsDependencies> = {}) {
  const runtime = { ...defaultDependencies, ...dependencies }
  const packages = [...REQUIRED_PYTHON_PACKAGES]

  return {
    async inspect(): Promise<RuntimeDiagnosticsReport> {
      return runtimeReportFromStatus(await runtime.getStatus(packages))
    },
    async install(): Promise<RuntimeDiagnosticsReport> {
      const current = await runtime.getStatus(packages)
      if (!current.ok) throw new Error("未检测到可运行的 Python 解释器，无法安装分析依赖。")
      if (current.missing.length === 0) return runtimeReportFromStatus(current)

      if (current.source === "env" || current.source === "config") {
        await withRuntimeInstallLock(runtimeInstallTargetKey(current), async () => {
          const latest = await runtime.getStatus(packages)
          if (!latest.ok) throw new Error("未检测到可运行的 Python 解释器，无法安装分析依赖。")
          const missing = packages.filter((packageName) => latest.missing.includes(packageName))
          if (missing.length > 0) await runtime.installPythonPackages(latest.executable, missing)
        })
      } else {
        const installed = await runtime.ensureRuntimePythonReady(packages)
        if (!installed.ok || installed.missing.length > 0) throw new Error("KillStata 受管分析环境尚未准备完成。")
        return runtimeReportFromStatus(installed)
      }

      const updated = await runtime.getStatus(packages)
      if (!updated.ok || updated.missing.length > 0) throw new Error("部分分析依赖未能安装，请检查当前 Python 的安装权限和网络连接。")
      return runtimeReportFromStatus(updated)
    },
  }
}

const defaultRuntimeDiagnostics = createRuntimeDiagnostics()

export const inspectRuntimeDiagnostics = defaultRuntimeDiagnostics.inspect
export const installRuntimeDiagnostics = defaultRuntimeDiagnostics.install
