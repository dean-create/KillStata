import { randomUUID } from "node:crypto"
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "../global"

const MAX_WORKSPACES = 128
const MAX_REGISTRY_BYTES = 512 * 1024
const UNASSIGNED_WORKSPACE_ID = "__unassigned__"

type WebWorkspace = { id: string; name: string }
type WorkspaceRegistry = { version: 1; workspaces: WebWorkspace[] }
export type LocalWebWorkspaceRegistryOptions = { dataDirectory?: string; launchDirectory?: string }

class WorkspaceRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function validWorkspaceID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) && value !== UNASSIGNED_WORKSPACE_ID
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 160
    && !/[\\/\u0000-\u001f\u007f]/.test(value)
}

function validateRegistry(value: unknown): WorkspaceRegistry {
  const input = object(value)
  if (!input || input.version !== 1 || !Array.isArray(input.workspaces) || input.workspaces.length > MAX_WORKSPACES) {
    throw new WorkspaceRequestError(500, "workspace_registry_invalid", "本机工作区索引格式无效。")
  }
  const workspaces = input.workspaces.map((raw) => {
    const workspace = object(raw)
    if (!workspace || !validWorkspaceID(workspace.id) || !validName(workspace.name)) {
      throw new WorkspaceRequestError(500, "workspace_registry_invalid", "本机工作区索引格式无效。")
    }
    return { id: workspace.id, name: workspace.name.trim() }
  })
  if (new Set(workspaces.map((item) => item.id)).size !== workspaces.length) {
    throw new WorkspaceRequestError(500, "workspace_registry_invalid", "本机工作区索引含重复 ID。")
  }
  return { version: 1, workspaces }
}

function jsonBody(request: Request): Promise<Record<string, unknown>> {
  return request.text().then((text) => {
    if (Buffer.byteLength(text, "utf8") > 8 * 1024) throw new WorkspaceRequestError(413, "workspace_request_too_large", "工作区请求超过安全上限。")
    const body = object(JSON.parse(text))
    if (!body) throw new WorkspaceRequestError(400, "workspace_request_invalid", "工作区请求格式无效。")
    return body
  }).catch((error) => {
    if (error instanceof WorkspaceRequestError) throw error
    throw new WorkspaceRequestError(400, "workspace_request_invalid", "工作区请求格式无效。")
  })
}

export function createLocalWebWorkspaceRegistry(options: LocalWebWorkspaceRegistryOptions = {}) {
  const dataDirectory = options.dataDirectory ?? Global.Path.data
  const launchDirectory = options.launchDirectory ?? process.cwd()
  const webRoot = path.join(dataDirectory, "web")
  const workspaceRoot = path.join(webRoot, "workspaces")
  const registryPath = path.join(webRoot, "workspaces.json")
  let mutationQueue = Promise.resolve()

  const serialize = <T>(operation: () => Promise<T>) => {
    const result = mutationQueue.then(operation)
    mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  async function readRegistry(): Promise<WorkspaceRegistry> {
    try {
      const metadata = await stat(registryPath)
      if (metadata.size > MAX_REGISTRY_BYTES) throw new WorkspaceRequestError(500, "workspace_registry_too_large", "本机工作区索引超过安全上限。")
      return validateRegistry(JSON.parse(await readFile(registryPath, "utf8")))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: [] }
      if (error instanceof WorkspaceRequestError) throw error
      throw new WorkspaceRequestError(500, "workspace_registry_unreadable", "本机工作区索引无法读取。")
    }
  }

  async function ensurePrivateRoots() {
    await mkdir(webRoot, { recursive: true, mode: 0o700 })
    await chmod(webRoot, 0o700)
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 })
    await chmod(workspaceRoot, 0o700)
  }

  async function writeRegistry(registry: WorkspaceRegistry) {
    const serialized = JSON.stringify(registry, null, 2)
    if (Buffer.byteLength(serialized, "utf8") > MAX_REGISTRY_BYTES) {
      throw new WorkspaceRequestError(413, "workspace_registry_too_large", "本机工作区索引超过安全上限。")
    }
    await ensurePrivateRoots()
    const temporaryPath = `${registryPath}.tmp-${process.pid}-${randomUUID()}`
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(temporaryPath, "wx", 0o600)
      await file.writeFile(serialized, "utf8")
      await file.sync()
      await file.close()
      file = undefined
      await rename(temporaryPath, registryPath)
      await chmod(registryPath, 0o600)
    } catch {
      await file?.close().catch(() => {})
      await rm(temporaryPath, { force: true }).catch(() => {})
      throw new WorkspaceRequestError(500, "workspace_registry_write_failed", "无法安全保存本机工作区索引。")
    }
  }

  async function ensureDirectory(id: string) {
    await ensurePrivateRoots()
    const directory = path.join(workspaceRoot, id)
    await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    })
    await chmod(directory, 0o700)
    return directory
  }

  async function register(id: string, name: string) {
    const registry = await readRegistry()
    const existing = registry.workspaces.find((item) => item.id === id)
    if (existing) {
      if (existing.name !== name) {
        existing.name = name
        await writeRegistry(registry)
      }
      const directory = await ensureDirectory(id)
      return { id, name, directory }
    }
    if (registry.workspaces.length >= MAX_WORKSPACES) {
      throw new WorkspaceRequestError(409, "workspace_limit", "本机工作区数量已达到上限。")
    }
    const directory = await ensureDirectory(id)
    registry.workspaces.push({ id, name })
    try { await writeRegistry(registry) }
    catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    return { id, name, directory }
  }

  return {
    async list() {
      const registry = await readRegistry()
      return registry.workspaces.map((item) => ({ ...item }))
    },
    async create(name: string) {
      if (!validName(name)) throw new WorkspaceRequestError(400, "workspace_name_invalid", "工作区名称无效。")
      return serialize(() => register(randomUUID(), name.trim()))
    },
    async ensure(id: string, name: string) {
      if (!validWorkspaceID(id) || !validName(name)) throw new WorkspaceRequestError(400, "workspace_identity_invalid", "工作区标识或名称无效。")
      return serialize(() => register(id, name.trim()))
    },
    async resolveDirectory(id: string) {
      if (id === UNASSIGNED_WORKSPACE_ID) return { id, name: "未归档研究", directory: launchDirectory }
      if (!validWorkspaceID(id)) throw new WorkspaceRequestError(400, "workspace_id_invalid", "工作区标识无效。")
      const registry = await readRegistry()
      const workspace = registry.workspaces.find((item) => item.id === id)
      if (!workspace) throw new WorkspaceRequestError(404, "workspace_not_found", "本机工作区不存在或已被移除。")
      const root = await realpath(workspaceRoot)
      let directory: string
      try { directory = await realpath(path.join(workspaceRoot, id)) }
      catch { throw new WorkspaceRequestError(410, "workspace_data_missing", "工作区数据目录不存在，请重新创建工作区。") }
      if (path.dirname(directory) !== root || path.basename(directory) !== id || !(await stat(directory)).isDirectory()) {
        throw new WorkspaceRequestError(403, "workspace_path_invalid", "工作区目录不在本机受管数据范围内。")
      }
      return { ...workspace, directory }
    },
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url)
      if (url.pathname !== "/api/v2/workspaces" && url.pathname !== "/api/v2/workspaces/ensure") return undefined
      try {
        if (url.pathname === "/api/v2/workspaces" && request.method === "GET") {
          return Response.json({ protocolVersion: "v2", workspaces: await this.list() })
        }
        if (request.method !== "POST") return errorResponse(new WorkspaceRequestError(405, "method_not_allowed", "本机工作区 API 不支持此请求方法。"))
        const body = await jsonBody(request)
        const allowedKeys = url.pathname.endsWith("/ensure") ? new Set(["id", "name"]) : new Set(["name"])
        if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
          throw new WorkspaceRequestError(400, "workspace_request_invalid", "工作区请求只允许提供工作区名称和不透明标识。")
        }
        const created = url.pathname.endsWith("/ensure")
          ? await this.ensure(String(body.id ?? ""), String(body.name ?? ""))
          : await this.create(String(body.name ?? ""))
        return Response.json({ protocolVersion: "v2", id: created.id, name: created.name }, { status: url.pathname.endsWith("/ensure") ? 200 : 201 })
      } catch (error) { return errorResponse(error) }
    },
  }
}

function errorResponse(error: unknown) {
  const typed = error instanceof WorkspaceRequestError ? error : undefined
  return Response.json({
    protocolVersion: "v2",
    code: typed?.code ?? "workspace_failure",
    message: typed?.message ?? "本机工作区服务暂时无法处理请求。",
    retryable: false,
  }, { status: typed?.status ?? 500 })
}
