import type { CoreApplication } from "../core/application"
import { CoreApplicationClient } from "../core/client"

type CoreCommand = {
  name: string
  description?: string
  hints?: string[]
  advanced?: boolean
  blockedReason?: string
  availability?: string[]
  queueBehavior?: "queued" | "immediate"
}

export type LocalWebCoreReadApi = {
  health(): Promise<{ version: string; healthy: boolean }>
  commands(): Promise<CoreCommand[]>
}

function failure(status: number, code: string, message: string) {
  return Response.json({ protocolVersion: "v2", code, message, retryable: false }, { status })
}

function safeCommand(value: CoreCommand) {
  if (!value || typeof value.name !== "string" || (value.description !== undefined && typeof value.description !== "string")) {
    throw new Error("Invalid Core command contract")
  }
  return {
    name: value.name.replace(/^\/+/, "").slice(0, 128),
    description: value.description?.trim().slice(0, 1_000) || "执行此命令",
    ...(Array.isArray(value.hints) ? { hints: value.hints.filter((hint) => typeof hint === "string").slice(0, 8).map((hint) => hint.slice(0, 256)) } : {}),
    ...(typeof value.advanced === "boolean" ? { advanced: value.advanced } : {}),
    ...(typeof value.blockedReason === "string" ? { blockedReason: value.blockedReason.slice(0, 500) } : {}),
    ...(Array.isArray(value.availability) ? { availability: value.availability.filter((item) => typeof item === "string").slice(0, 16) } : {}),
    ...(value.queueBehavior === "queued" || value.queueBehavior === "immediate" ? { queueBehavior: value.queueBehavior } : {}),
  }
}

export function createLocalWebApi(core: LocalWebCoreReadApi) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (request.method !== "GET" && request.method !== "HEAD") {
      return failure(405, "method_not_allowed", "本机 Web API 不支持此请求方法")
    }
    if (url.pathname === "/api/v2/health") {
      const health = await core.health()
      return Response.json({
        protocolVersion: "v2",
        engineVersion: health.version,
        status: health.healthy ? "ready" : "unavailable",
        capabilities: { structuredSteps: true, interactive: true },
      })
    }
    if (url.pathname === "/api/v2/commands") {
      const commands = await core.commands()
      if (!Array.isArray(commands) || commands.length > 256) {
        return failure(502, "invalid_core_response", "分析核心返回的命令目录无效")
      }
      return Response.json({ protocolVersion: "v2", commands: commands.map(safeCommand) })
    }
    return failure(404, "route_not_found", "本机 Web API 路径不存在")
  }
}

export function createLocalWebApiFromCore(application: CoreApplication) {
  const sdk = CoreApplicationClient.inProcess(application).sdk
  return createLocalWebApi({
    async health() {
      const result = await sdk.global.health({ throwOnError: true })
      return { version: result.data.version, healthy: result.data.healthy }
    },
    async commands() {
      const result = await sdk.command.list({}, { throwOnError: true })
      return result.data.map((command) => ({
        name: command.name,
        description: command.description,
        hints: command.hints,
        advanced: command.advanced,
        blockedReason: command.blockedReason,
        availability: command.availability,
        queueBehavior: command.queueBehavior,
      }))
    },
  })
}
