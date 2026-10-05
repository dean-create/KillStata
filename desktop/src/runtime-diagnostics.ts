import { PYTHON_RUNTIME_PACKAGES } from "./provider-config"

export type RuntimeCheckStatus = "ready" | "warning" | "error"

export type RuntimeCheck = {
  label: string
  status: RuntimeCheckStatus
  detail: string
  suggestion: string
}

export type RuntimeDiagnosticsReport = {
  python: RuntimeCheck
  packages: RuntimeCheck[]
}

const INVALID_RUNTIME_REPORT = "本机运行环境响应格式无效"

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function parseRuntimeCheck(value: unknown): RuntimeCheck {
  if (!isRecord(value)
    || typeof value.label !== "string"
    || value.label.length > 160
    || (value.status !== "ready" && value.status !== "warning" && value.status !== "error")
    || typeof value.detail !== "string"
    || value.detail.length > 4096
    || typeof value.suggestion !== "string"
    || value.suggestion.length > 1024) {
    throw new Error(INVALID_RUNTIME_REPORT)
  }
  return {
    label: value.label,
    status: value.status,
    detail: value.detail,
    suggestion: value.suggestion,
  }
}

export function parseRuntimeDiagnosticsReport(value: unknown): RuntimeDiagnosticsReport {
  if (!isRecord(value) || !Array.isArray(value.packages) || value.packages.length > PYTHON_RUNTIME_PACKAGES.length) {
    throw new Error(INVALID_RUNTIME_REPORT)
  }
  const python = parseRuntimeCheck(value.python)
  const packages = value.packages.map(parseRuntimeCheck)
  const expected = new Set(PYTHON_RUNTIME_PACKAGES.map((item) => item.pip))
  const received = new Set(packages.map((item) => item.label))
  if (received.size !== packages.length || received.size !== expected.size || [...received].some((label) => !expected.has(label))) {
    throw new Error(INVALID_RUNTIME_REPORT)
  }
  return { python, packages }
}

export interface RuntimeDiagnostics {
  inspect(): Promise<RuntimeDiagnosticsReport>
  /** 只允许安装 Desktop 固定维护的分析依赖；实现端不得接收任意包名。 */
  installMissingPackages?(): Promise<RuntimeDiagnosticsReport>
}

/** 浏览器预览没有本机命令权限，必须明确显示未检测而非模拟绿色状态。 */
export function createDemoRuntimeDiagnostics(): RuntimeDiagnostics {
  return {
    inspect: async () => ({
      python: {
        label: "Python 解释器",
        status: "warning",
        detail: "仅桌面应用可检测本机运行环境。",
        suggestion: "请在 KillStata Desktop 中打开此设置页。",
      },
      packages: PYTHON_RUNTIME_PACKAGES.map(({ pip, purpose }) => ({
        label: pip,
        status: "warning",
        detail: "仅桌面应用可检测。",
        suggestion: purpose,
      })),
    }),
  }
}
