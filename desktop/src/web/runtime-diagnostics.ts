import type { RuntimeDiagnostics } from "../runtime-diagnostics"
import { parseRuntimeDiagnosticsReport } from "../runtime-diagnostics"

export function createWebRuntimeDiagnostics(fetcher: typeof fetch = fetch, workspaceID?: () => string): RuntimeDiagnostics {
  const request = async (path: string, method = "GET") => {
    const headers = new Headers()
    const currentWorkspaceID = workspaceID?.()
    if (currentWorkspaceID) headers.set("x-killstata-workspace-id", currentWorkspaceID)
    const response = await fetcher(path, { method, credentials: "same-origin", headers })
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const message = body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : "本机运行环境服务暂时无法处理请求。"
      throw new Error(message.slice(0, 500))
    }
    return parseRuntimeDiagnosticsReport(body)
  }
  return {
    inspect: () => request("/api/v2/runtime"),
    installMissingPackages: () => request("/api/v2/runtime/install", "POST"),
  }
}
