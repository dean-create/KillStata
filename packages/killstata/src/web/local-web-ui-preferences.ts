import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import { userRoot } from "../killstata/runtime-config"

export type SharedUiPreferenceKey = "theme" | "reasoningEffort" | "permissionMode"
export type SharedUiPreferences = Partial<Record<SharedUiPreferenceKey, string>>
export type LocalWebUiPreferenceHandler = (request: Request) => Promise<Response | undefined>

const PREFERENCE_VALUES: Record<SharedUiPreferenceKey, ReadonlySet<string>> = {
  theme: new Set(["system", "light", "dark"]),
  reasoningEffort: new Set(["default", "low", "medium", "high"]),
  permissionMode: new Set(["read_only", "workspace_write", "full_access"]),
}
const MAXIMUM_PREFERENCE_REQUEST_BYTES = 1024

function isPreferenceKey(value: unknown): value is SharedUiPreferenceKey {
  return value === "theme" || value === "reasoningEffort" || value === "permissionMode"
}

function isPreferenceValue(key: SharedUiPreferenceKey, value: unknown): value is string {
  return typeof value === "string" && PREFERENCE_VALUES[key].has(value)
}

function error(status: number, code: string, message: string) {
  return Response.json({ protocolVersion: "v2", code, message, retryable: false }, { status })
}

export function createLocalWebUiPreferences(options: { root?: string } = {}) {
  const root = options.root ?? userRoot()
  const directory = path.join(root, "ui-preferences")

  const fileFor = (key: SharedUiPreferenceKey) => path.join(directory,
    key === "theme" ? "theme" : key === "reasoningEffort" ? "reasoning-effort" : "permission-mode")

  async function secureDirectory(directoryPath: string, create: boolean) {
    let metadata
    try {
      metadata = await lstat(directoryPath)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false
        throw cause
      }
      await mkdir(directoryPath, { recursive: true, mode: 0o700 })
      metadata = await lstat(directoryPath)
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("UI preference directory is not a private directory")
    if (process.platform !== "win32") await chmod(directoryPath, 0o700)
    return true
  }

  async function ensurePrivateDirectory() {
    await secureDirectory(root, true)
    await secureDirectory(directory, true)
  }

  async function ensureExistingPreferenceDirectory() {
    if (!await secureDirectory(root, false)) return false
    return await secureDirectory(directory, false)
  }

  async function read(key: SharedUiPreferenceKey): Promise<string | undefined> {
    try {
      const file = fileFor(key)
      const metadata = await lstat(file)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64) throw new Error("UI preference file is invalid")
      const value = (await readFile(file, "utf8")).trim()
      if (!isPreferenceValue(key, value)) throw new Error("UI preference value is invalid")
      return value
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw cause
    }
  }

  async function load(): Promise<SharedUiPreferences> {
    if (!await ensureExistingPreferenceDirectory()) return {}
    const [theme, reasoningEffort, permissionMode] = await Promise.all([
      read("theme"),
      read("reasoningEffort"),
      read("permissionMode"),
    ])
    return {
      ...(theme ? { theme } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    }
  }

  async function write(key: SharedUiPreferenceKey, value: string, onlyIfAbsent = false) {
    await ensurePrivateDirectory()
    const target = fileFor(key)
    if (onlyIfAbsent) {
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(target, "wx", 0o600)
        await handle.writeFile(value, "utf8")
        await handle.sync()
        return true
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false
        throw cause
      } finally {
        await handle?.close()
      }
    }

    const temporary = path.join(directory, `.${path.basename(target)}-${randomUUID()}.tmp`)
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(value, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, target)
      if (process.platform !== "win32") await chmod(target, 0o600)
    } catch (cause) {
      await rm(temporary, { force: true })
      throw cause
    }
    return true
  }

  const handle: LocalWebUiPreferenceHandler = async (request) => {
    const url = new URL(request.url)
    if (url.pathname !== "/api/v2/ui-preferences") return undefined
    if (request.method === "GET") {
      try {
        return Response.json({ protocolVersion: "v2", preferences: await load() })
      } catch {
        return error(500, "ui_preferences_unavailable", "无法读取本机界面偏好设置。")
      }
    }
    if (request.method !== "PUT") return error(405, "method_not_allowed", "本机界面偏好只支持读取与更新。")

    let bodyText: string
    try { bodyText = await request.text() }
    catch { return error(400, "ui_preference_request_invalid", "界面偏好请求无法读取。") }
    if (Buffer.byteLength(bodyText, "utf8") > MAXIMUM_PREFERENCE_REQUEST_BYTES) {
      return error(413, "ui_preference_request_too_large", "界面偏好请求超过安全上限。")
    }
    let body: unknown
    try { body = JSON.parse(bodyText) }
    catch { return error(400, "ui_preference_request_invalid", "界面偏好请求格式无效。") }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return error(400, "ui_preference_request_invalid", "界面偏好请求无法处理。")
    }
    const record = body as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.some((key) => !["key", "value", "onlyIfAbsent"].includes(key))
      || (keys.length !== 2 && keys.length !== 3)
      || !keys.includes("key") || !keys.includes("value")
      || ("onlyIfAbsent" in record && typeof record.onlyIfAbsent !== "boolean")
      || !isPreferenceKey(record.key)
      || !isPreferenceValue(record.key, record.value)) {
      return error(400, "ui_preference_request_invalid", "界面偏好键或值无效。")
    }
    try {
      const saved = await write(record.key, record.value, record.onlyIfAbsent === true)
      return Response.json({ protocolVersion: "v2", saved })
    } catch {
      return error(500, "ui_preferences_unavailable", "无法保存本机界面偏好设置。")
    }
  }

  return { handle, load }
}
