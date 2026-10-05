import { createRuntimeDiagnostics, runtimeReportFromStatus, type RuntimeDiagnosticsReport } from "../killstata/runtime-diagnostics"

export { runtimeReportFromStatus }
export type LocalWebRuntimeCheck = RuntimeDiagnosticsReport["python"]
export type LocalWebRuntimeReport = RuntimeDiagnosticsReport
export type LocalWebRuntimeContext = <T>(operation: () => Promise<T>) => Promise<T>
export type LocalWebRuntimeDependencies = {
  inspect?: () => Promise<LocalWebRuntimeReport>
  install?: () => Promise<LocalWebRuntimeReport>
  runInCoreContext?: LocalWebRuntimeContext
}

function errorResponse(status: number, code: string, message: string) {
  return Response.json({ protocolVersion: "v2", code, message, retryable: false }, { status })
}

export function createLocalWebRuntimeDiagnostics(
  dependencies: LocalWebRuntimeDependencies = {},
) {
  const runInCoreContext = dependencies.runInCoreContext ?? (async <T>(operation: () => Promise<T>) => operation())
  const coreRuntime = createRuntimeDiagnostics()
  const inspect = dependencies.inspect ?? coreRuntime.inspect
  const install = dependencies.install ?? coreRuntime.install
  let installing: Promise<LocalWebRuntimeReport> | undefined
  return {
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url)
      if (url.pathname !== "/api/v2/runtime" && url.pathname !== "/api/v2/runtime/install") return undefined
      if (url.pathname === "/api/v2/runtime" && request.method !== "GET") {
        return errorResponse(405, "method_not_allowed", "本机运行环境 API 不支持此请求方法。")
      }
      if (url.pathname === "/api/v2/runtime/install" && request.method !== "POST") {
        return errorResponse(405, "method_not_allowed", "本机运行环境 API 不支持此请求方法。")
      }
      try {
        if (url.pathname === "/api/v2/runtime") return Response.json(await runInCoreContext(inspect))
        if (request.body !== null) return errorResponse(400, "runtime_install_input_rejected", "运行环境安装请求不能携带参数。")
        if (!installing) {
          installing = runInCoreContext(install).finally(() => { installing = undefined })
        }
        return Response.json(await installing)
      } catch {
        return errorResponse(500, "runtime_operation_failed", "本机分析环境操作未完成，请重新检查运行环境后重试。")
      }
    },
  }
}
