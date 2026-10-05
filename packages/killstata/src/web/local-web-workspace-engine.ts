import type { CoreApplication } from "../core/application"
import { createLocalWebWorkspaceRegistry } from "./local-web-workspaces"
import type { LocalWebCredentialHandler, LocalWebEngineApi, LocalWebRuntimeHandler } from "./local-web-engine"
import type { LocalWebUiPreferenceHandler } from "./local-web-ui-preferences"

const UNASSIGNED_WORKSPACE_ID = "__unassigned__"
const DEFAULT_MAX_LIVE_CORES = 8

type WorkspaceRegistry = ReturnType<typeof createLocalWebWorkspaceRegistry>
type WorkspaceCoreService = {
  id: string
  directory: string
  lastUsedAt: number
  application: CoreApplication
  api: LocalWebEngineApi
}

export type LocalWebWorkspaceEngineOptions = {
  registry: WorkspaceRegistry
  createCore(options: { directory: string }): Promise<CoreApplication>
  createApi(application: CoreApplication, runtimeHandler?: LocalWebRuntimeHandler): LocalWebEngineApi
  createRuntimeHandler(directory: string): LocalWebRuntimeHandler
  credentialHandler?: LocalWebCredentialHandler
  uiPreferenceHandler?: LocalWebUiPreferenceHandler
  maxLiveCores?: number
}

export type LocalWebWorkspaceEngine = ((request: Request) => Promise<Response>) & {
  warmup(workspaceID?: string): Promise<void>
  resetAll(): Promise<void>
  shutdown(): Promise<void>
  dispose(): void
}

function errorResponse(status: number, code: string, message: string) {
  return Response.json({ protocolVersion: "v2", code, message, retryable: false }, { status })
}

function workspaceRequestID(request: Request): { id?: string; error?: string } {
  const url = new URL(request.url)
  const headerID = request.headers.get("x-killstata-workspace-id") ?? undefined
  const queryID = url.pathname.endsWith("/events") ? url.searchParams.get("workspaceId") ?? undefined : undefined
  if (headerID && queryID && headerID !== queryID) return { error: "工作区请求上下文冲突。" }
  const id = headerID ?? queryID ?? UNASSIGNED_WORKSPACE_ID
  if (!/^(?:__unassigned__|[A-Za-z0-9_-]{1,128})$/.test(id)) return { error: "工作区标识无效。" }
  return { id }
}

export function createLocalWebWorkspaceEngine(options: LocalWebWorkspaceEngineOptions): LocalWebWorkspaceEngine {
  const services = new Map<string, WorkspaceCoreService>()
  const maximumCores = options.maxLiveCores ?? DEFAULT_MAX_LIVE_CORES
  let disposed = false
  let queue = Promise.resolve()

  const serialize = <T>(operation: () => Promise<T>) => {
    const result = queue.then(operation)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  async function disposeService(service: WorkspaceCoreService) {
    services.delete(service.id)
    service.api.dispose()
    await service.application.dispose()
  }

  async function disposeServices() {
    const existing = [...services.values()]
    services.clear()
    for (const service of existing) {
      service.api.dispose()
      await service.application.dispose()
    }
  }

  async function serviceFor(workspaceID: string): Promise<WorkspaceCoreService> {
    return serialize(async () => {
      if (disposed) throw new Error("Web workspace engine is shut down")
      const existing = services.get(workspaceID)
      if (existing) {
        existing.lastUsedAt = Date.now()
        return existing
      }

      const workspace = await options.registry.resolveDirectory(workspaceID)
      if (services.size >= maximumCores) {
        const evictable = [...services.values()]
          .filter((service) => service.api.isIdle())
          .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0]
        if (!evictable) throw new Error("workspace_core_capacity")
        await disposeService(evictable)
      }

      const application = await options.createCore({ directory: workspace.directory })
      try {
        const api = options.createApi(application, options.createRuntimeHandler(workspace.directory))
        const service = { id: workspaceID, directory: workspace.directory, lastUsedAt: Date.now(), application, api }
        services.set(workspaceID, service)
        return service
      } catch (error) {
        await application.dispose()
        throw error
      }
    })
  }

  const engine = Object.assign(async (request: Request): Promise<Response> => {
    if (disposed) return errorResponse(503, "workspace_engine_stopped", "本机 Web 工作区服务已停止。")
    const uiPreferenceResponse = await options.uiPreferenceHandler?.(request)
    if (uiPreferenceResponse) return uiPreferenceResponse
    const workspaceResponse = await options.registry.handle(request)
    if (workspaceResponse) return workspaceResponse
    const credentialResponse = await options.credentialHandler?.(request)
    if (credentialResponse) return credentialResponse
    const requested = workspaceRequestID(request)
    if (requested.error) return errorResponse(400, "workspace_id_invalid", requested.error)

    try {
      const service = await serviceFor(requested.id!)
      return await service.api(request)
    } catch (error) {
      if (error instanceof Error && error.message === "workspace_core_capacity") {
        return errorResponse(429, "workspace_core_capacity", "其他工作区仍有运行中的分析，请先完成或停止后重试。")
      }
      return errorResponse(404, "workspace_unavailable", "本机工作区不存在或分析核心无法启动；请重新选择工作区后重试。")
    }
  }, {
    async warmup(workspaceID = UNASSIGNED_WORKSPACE_ID) { await serviceFor(workspaceID) },
    async resetAll() { await serialize(disposeServices) },
    async shutdown() {
      if (disposed) return
      disposed = true
      await serialize(disposeServices)
    },
    dispose() { void engine.shutdown() },
  })
  return engine as LocalWebWorkspaceEngine
}
