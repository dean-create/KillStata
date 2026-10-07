import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { lock } from "proper-lockfile"
import { Global } from "../global"

const MAX_WORKSPACES = 128
const MAX_PREPARED_WORKSPACES = 128
const PREPARED_WORKSPACE_LIFETIME_MS = 60_000
const MAX_REGISTRY_BYTES = 512 * 1024
const REGISTRY_LOCK_STALE_MS = 30_000
const UNASSIGNED_WORKSPACE_ID = "__unassigned__"

type WebWorkspace = { id: string; name: string; accessTokenHash?: string }
type WorkspaceRegistry = { version: 1; workspaces: WebWorkspace[] }
type ManagedWorkspace = { id: string; name: string; directory: string; accessToken: string }
export type LocalWebWorkspaceRegistryOptions = { dataDirectory?: string; launchDirectory?: string; now?: () => number }

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

function hashAccessToken(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function createAccessToken() {
  return randomBytes(32).toString("base64url")
}

function matchesAccessToken(value: unknown, expectedHash: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(value)) return false
  const actual = Buffer.from(hashAccessToken(value), "hex")
  const expected = Buffer.from(expectedHash, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function validateRegistry(value: unknown): WorkspaceRegistry {
  const input = object(value)
  if (!input || input.version !== 1 || !Array.isArray(input.workspaces) || input.workspaces.length > MAX_WORKSPACES) {
    throw new WorkspaceRequestError(500, "workspace_registry_invalid", "本机工作区索引格式无效。")
  }
  const workspaces = input.workspaces.map((raw) => {
    const workspace = object(raw)
    if (!workspace || !validWorkspaceID(workspace.id) || !validName(workspace.name)
      || workspace.accessTokenHash !== undefined && (typeof workspace.accessTokenHash !== "string" || !/^[a-f0-9]{64}$/.test(workspace.accessTokenHash))) {
      throw new WorkspaceRequestError(500, "workspace_registry_invalid", "本机工作区索引格式无效。")
    }
    return {
      id: workspace.id,
      name: workspace.name.trim(),
      ...(typeof workspace.accessTokenHash === "string" ? { accessTokenHash: workspace.accessTokenHash } : {}),
    }
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
  const now = options.now ?? Date.now
  const webRoot = path.join(dataDirectory, "web")
  const workspaceRoot = path.join(webRoot, "workspaces")
  const registryPath = path.join(webRoot, "workspaces.json")
  const preparedWorkspaces = new Map<string, { name: string; accessTokenHash: string; expiresAt: number }>()
  let mutationQueue = Promise.resolve()

  function prunePreparedWorkspaces() {
    for (const [id, prepared] of preparedWorkspaces) {
      if (now() >= prepared.expiresAt) preparedWorkspaces.delete(id)
    }
  }

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

  async function withRegistryLock<T>(operation: () => Promise<T>) {
    await ensurePrivateRoots()
    let release: (() => Promise<void>) | undefined
    try {
      release = await lock(webRoot, {
        lockfilePath: path.join(webRoot, "workspaces.json.lock"),
        stale: REGISTRY_LOCK_STALE_MS,
        update: REGISTRY_LOCK_STALE_MS / 3,
        retries: { retries: 50, minTimeout: 20, maxTimeout: 100, randomize: true },
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
        throw new WorkspaceRequestError(503, "workspace_registry_busy", "本机工作区索引正在更新，请稍后重试。")
      }
      throw error
    }
    try { return await operation() }
    finally { await release() }
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

  async function register(id: string, name: string, accessTokenHash: string) {
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
    registry.workspaces.push({ id, name, accessTokenHash })
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
      return registry.workspaces.map(({ id, name }) => ({ id, name }))
    },
    async create(name: string) {
      if (!validName(name)) throw new WorkspaceRequestError(400, "workspace_name_invalid", "工作区名称无效。")
      const accessToken = createAccessToken()
      const workspace = await serialize(() => withRegistryLock(() => register(randomUUID(), name.trim(), hashAccessToken(accessToken))))
      return { ...workspace, accessToken }
    },
    async prepare(name: string) {
      if (!validName(name)) throw new WorkspaceRequestError(400, "workspace_name_invalid", "工作区名称无效。")
      prunePreparedWorkspaces()
      if (preparedWorkspaces.size >= MAX_PREPARED_WORKSPACES) {
        throw new WorkspaceRequestError(429, "workspace_preparation_limit", "待确认的访客工作区过多，请稍后重试。")
      }
      const id = randomUUID()
      const accessToken = createAccessToken()
      const normalizedName = name.trim()
      preparedWorkspaces.set(id, {
        name: normalizedName,
        accessTokenHash: hashAccessToken(accessToken),
        expiresAt: now() + PREPARED_WORKSPACE_LIFETIME_MS,
      })
      return { id, name: normalizedName, accessToken }
    },
    async createPrepared(name: string, id: unknown, accessToken: unknown) {
      if (!validWorkspaceID(id) || !validName(name) || typeof accessToken !== "string") {
        throw new WorkspaceRequestError(400, "workspace_identity_invalid", "工作区标识或名称无效。")
      }
      return serialize(() => withRegistryLock(async () => {
        prunePreparedWorkspaces()
        const prepared = preparedWorkspaces.get(id)
        if (!prepared) throw new WorkspaceRequestError(404, "workspace_preparation_expired", "访客工作区准备信息已过期，请重新选择工作区。")
        if (prepared.name !== name.trim() || !matchesAccessToken(accessToken, prepared.accessTokenHash)) {
          throw new WorkspaceRequestError(403, "workspace_preparation_invalid", "访客工作区准备凭据无效。")
        }
        const registry = await readRegistry()
        if (registry.workspaces.some((workspace) => workspace.id === id)) {
          throw new WorkspaceRequestError(409, "workspace_id_conflict", "工作区标识已存在，请重新选择工作区。")
        }
        if (registry.workspaces.length >= MAX_WORKSPACES) {
          throw new WorkspaceRequestError(409, "workspace_limit", "本机工作区数量已达到上限。")
        }
        const workspace = await register(id, name.trim(), prepared.accessTokenHash)
        preparedWorkspaces.delete(id)
        return { ...workspace, accessToken }
      }))
    },
    async ensure(id: string, name: string, accessToken: unknown, localOwner: boolean) {
      if (!validWorkspaceID(id) || !validName(name)) throw new WorkspaceRequestError(400, "workspace_identity_invalid", "工作区标识或名称无效。")
      return serialize(() => withRegistryLock(async () => {
        const registry = await readRegistry()
        const existing = registry.workspaces.find((item) => item.id === id)
        if (!existing) {
          if (!localOwner) {
            prunePreparedWorkspaces()
            const prepared = preparedWorkspaces.get(id)
            if (!prepared || prepared.name !== name.trim() || !matchesAccessToken(accessToken, prepared.accessTokenHash)) {
              throw new WorkspaceRequestError(404, "workspace_not_found", "本机工作区不存在或已被移除。")
            }
            const workspace = await register(id, name.trim(), prepared.accessTokenHash)
            preparedWorkspaces.delete(id)
            return { ...workspace, accessToken: accessToken as string }
          }
          const nextToken = createAccessToken()
          const workspace = await register(id, name.trim(), hashAccessToken(nextToken))
          return { ...workspace, accessToken: nextToken }
        }

        let nextToken: string
        let changed = false
        if (existing.accessTokenHash && matchesAccessToken(accessToken, existing.accessTokenHash)) {
          nextToken = accessToken as string
        } else if (localOwner) {
          nextToken = createAccessToken()
          existing.accessTokenHash = hashAccessToken(nextToken)
          changed = true
        } else {
          throw new WorkspaceRequestError(403, "workspace_access_denied", "访客工作区凭据无效，请重新选择该浏览器中的工作区。")
        }
        if (existing.name !== name.trim()) {
          existing.name = name.trim()
          changed = true
        }
        if (changed) await writeRegistry(registry)
        const directory = await ensureDirectory(id)
        return { id, name: name.trim(), directory, accessToken: nextToken }
      }))
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
      return { id: workspace.id, name: workspace.name, directory }
    },
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url)
      if (url.pathname !== "/api/v2/workspaces" && url.pathname !== "/api/v2/workspaces/ensure"
        && url.pathname !== "/api/v2/workspaces/prepare") return undefined
      try {
        if (url.pathname === "/api/v2/workspaces" && request.method === "GET") {
          return Response.json({ protocolVersion: "v2", workspaces: await this.list() })
        }
        if (request.method !== "POST") return errorResponse(new WorkspaceRequestError(405, "method_not_allowed", "本机工作区 API 不支持此请求方法。"))
        const body = await jsonBody(request)
        const localOwner = request.headers.get("x-killstata-workspace-role") !== "visitor"
        if (url.pathname.endsWith("/prepare") && localOwner) {
          throw new WorkspaceRequestError(403, "workspace_prepare_visitor_only", "工作区准备接口仅供已授权的分享访客使用。")
        }
        const allowedKeys = url.pathname.endsWith("/ensure")
          ? new Set(["id", "name", "accessToken"])
          : url.pathname.endsWith("/prepare") || localOwner ? new Set(["name"]) : new Set(["id", "name", "accessToken"])
        if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
          throw new WorkspaceRequestError(400, "workspace_request_invalid", "工作区请求包含不允许的字段。")
        }
        if (url.pathname === "/api/v2/workspaces" && !localOwner
          && request.headers.get("x-killstata-workspace-preparation") !== "1") {
          throw new WorkspaceRequestError(403, "workspace_preparation_required", "访客工作区必须先在当前会话中完成安全准备。")
        }
        const created = url.pathname.endsWith("/ensure")
          ? await this.ensure(String(body.id ?? ""), String(body.name ?? ""), body.accessToken, localOwner)
          : url.pathname.endsWith("/prepare")
            ? await this.prepare(String(body.name ?? ""))
            : localOwner
              ? await this.create(String(body.name ?? ""))
              : await this.createPrepared(String(body.name ?? ""), body.id, body.accessToken)
        const status = url.pathname.endsWith("/ensure") || url.pathname.endsWith("/prepare") ? 200 : 201
        return Response.json({ protocolVersion: "v2", id: created.id, name: created.name, accessToken: created.accessToken }, { status })
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
