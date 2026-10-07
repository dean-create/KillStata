export type BrowserWorkspaceDirectory = {
  name: string
  isSameEntry?: (other: BrowserWorkspaceDirectory) => Promise<boolean>
}

type BrowserWorkspaceIdentity = { id: string; name: string; accessToken?: string }
type SavedBrowserWorkspace = BrowserWorkspaceIdentity & { directory?: BrowserWorkspaceDirectory }

type BrowserWorkspacePickerDependencies = {
  pickDirectory(): Promise<BrowserWorkspaceDirectory | undefined>
  pickFile(directory?: BrowserWorkspaceDirectory): Promise<File | undefined>
  createWorkspace(name: string, prepared?: BrowserWorkspaceIdentity): Promise<BrowserWorkspaceIdentity>
  prepareWorkspace?(name: string): Promise<BrowserWorkspaceIdentity>
  findWorkspace?(directory: BrowserWorkspaceDirectory): Promise<BrowserWorkspaceIdentity | undefined>
  rememberWorkspace?(workspace: BrowserWorkspaceIdentity, directory: BrowserWorkspaceDirectory): Promise<void>
  ensureWorkspace?(id: string, name: string, accessToken?: string): Promise<BrowserWorkspaceIdentity>
  loadAccessToken?(id: string): Promise<string | undefined>
  allowWorkspaceCapabilityReset?: boolean
  loadDirectory?(id: string): Promise<BrowserWorkspaceDirectory | undefined>
}

export type BrowserSharedWorkspacePickerDependencies = BrowserWorkspacePickerDependencies

type NativeFileHandle = { getFile(): Promise<File> }
type NativeDirectoryHandle = BrowserWorkspaceDirectory
type BrowserFilePickerAPI = typeof globalThis & {
  showDirectoryPicker?: () => Promise<NativeDirectoryHandle>
  showOpenFilePicker?: (options?: { startIn?: NativeDirectoryHandle; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<NativeFileHandle[]>
}

const DATASET_FILE_TYPES = [{
  description: "KillStata 数据文件",
  accept: {
    "text/csv": [".csv"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    "application/vnd.ms-excel": [".xls"],
    "application/x-stata": [".dta"],
    "application/vnd.apache.parquet": [".parquet"],
  },
}]

const WORKSPACE_DATABASE_NAME = "killstata-web-workspaces"
const WORKSPACE_DATABASE_VERSION = 1
const WORKSPACE_OBJECT_STORE = "directories"

function isPickerCancelled(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

function selectWithBrowserInput(directory: boolean): Promise<File[] | undefined> {
  const input = document.createElement("input")
  input.type = "file"
  if (!directory) input.accept = ".csv,.xlsx,.xls,.dta,.parquet"
  input.multiple = directory
  if (directory) input.setAttribute("webkitdirectory", "")

  return new Promise((resolve) => {
    let finished = false
    const finish = (files?: File[]) => {
      if (finished) return
      finished = true
      input.removeEventListener("change", onChange)
      input.removeEventListener("cancel", onCancel)
      input.remove()
      resolve(files)
    }
    const onChange = () => finish(input.files ? Array.from(input.files) : [])
    const onCancel = () => finish(undefined)
    input.addEventListener("change", onChange)
    input.addEventListener("cancel", onCancel)
    document.body.append(input)
    input.click()
  })
}

async function pickBrowserDirectory(): Promise<NativeDirectoryHandle | undefined> {
  const picker = globalThis as BrowserFilePickerAPI
  if (picker.showDirectoryPicker) {
    try {
      return await picker.showDirectoryPicker()
    } catch (error) {
      if (isPickerCancelled(error)) return undefined
      throw error
    }
  }

  const files = await selectWithBrowserInput(true)
  if (!files) return undefined
  const firstFile = files[0]
  const name = firstFile?.webkitRelativePath.split("/")[0]
    ?? firstFile?.name.replace(/\.[^.]+$/, "")
    ?? "本地工作区"
  return { name }
}

async function pickBrowserFile(directory?: NativeDirectoryHandle) {
  const picker = globalThis as BrowserFilePickerAPI
  if (picker.showOpenFilePicker) {
    try {
      const [handle] = await picker.showOpenFilePicker({ startIn: directory, types: DATASET_FILE_TYPES })
      return handle?.getFile()
    } catch (error) {
      if (isPickerCancelled(error)) return undefined
      throw error
    }
  }

  const files = await selectWithBrowserInput(false)
  return files?.[0]
}

async function createServerWorkspace(name: string) {
  return requestServerWorkspace("/api/v2/workspaces", { name })
}

async function prepareServerWorkspace(name: string) {
  return requestServerWorkspace("/api/v2/workspaces/prepare", { name })
}

async function createPreparedServerWorkspace(name: string, prepared?: BrowserWorkspaceIdentity) {
  if (!prepared?.accessToken) throw new Error("访客工作区缺少已保存的凭据，请重新选择工作区。")
  return requestServerWorkspace("/api/v2/workspaces", {
    id: prepared.id,
    name,
    accessToken: prepared.accessToken,
  }, prepared.id, prepared.accessToken)
}

async function ensureServerWorkspace(id: string, name: string, accessToken?: string) {
  return requestServerWorkspace("/api/v2/workspaces/ensure", { id, name, ...(accessToken ? { accessToken } : {}) }, id)
}

async function requestServerWorkspace(path: string, body: Record<string, string>, expectedID?: string, expectedAccessToken?: string) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => undefined) as { id?: unknown; name?: unknown; accessToken?: unknown; message?: unknown } | undefined
  if (!response.ok || !result || typeof result.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(result.id)
    || result.id === "__unassigned__" || expectedID && result.id !== expectedID || typeof result.name !== "string"
    || typeof result.accessToken !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(result.accessToken)
    || expectedAccessToken && result.accessToken !== expectedAccessToken) {
    throw new Error(typeof result?.message === "string" ? result.message : "无法在本机创建工作区，请重试。")
  }
  return { id: result.id, name: result.name, accessToken: result.accessToken }
}

function validSavedWorkspace(value: unknown): value is SavedBrowserWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const workspace = value as Record<string, unknown>
  const directory = workspace.directory as BrowserWorkspaceDirectory | undefined
  return typeof workspace.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(workspace.id)
    && workspace.id !== "__unassigned__" && typeof workspace.name === "string" && workspace.name.length <= 160
    && (workspace.accessToken === undefined || typeof workspace.accessToken === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(workspace.accessToken))
    && (directory === undefined || Boolean(directory && typeof directory.name === "string" && typeof directory.isSameEntry === "function"))
}

function openWorkspaceDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"))
      return
    }
    const request = indexedDB.open(WORKSPACE_DATABASE_NAME, WORKSPACE_DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WORKSPACE_OBJECT_STORE)) {
        request.result.createObjectStore(WORKSPACE_OBJECT_STORE, { keyPath: "id" })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"))
  })
}

function idbResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })
}

async function readSavedWorkspaces() {
  const database = await openWorkspaceDatabase()
  try {
    const values = await idbResult(database.transaction(WORKSPACE_OBJECT_STORE, "readonly").objectStore(WORKSPACE_OBJECT_STORE).getAll())
    return values.filter(validSavedWorkspace)
  } finally {
    database.close()
  }
}

async function findSavedWorkspace(directory: BrowserWorkspaceDirectory) {
  if (!directory.isSameEntry) return undefined
  try {
    for (const workspace of await readSavedWorkspaces()) {
      if (workspace.directory?.isSameEntry && await workspace.directory.isSameEntry(directory)) return {
        id: workspace.id,
        name: workspace.name,
        ...(workspace.accessToken ? { accessToken: workspace.accessToken } : {}),
      }
    }
  } catch {
    // Browser storage can be disabled; continue with an in-memory workspace for this page.
  }
  return undefined
}

async function rememberSavedWorkspace(workspace: BrowserWorkspaceIdentity, directory: BrowserWorkspaceDirectory) {
  const database = await openWorkspaceDatabase()
  try {
    const transaction = database.transaction(WORKSPACE_OBJECT_STORE, "readwrite")
    transaction.objectStore(WORKSPACE_OBJECT_STORE).put({
      ...workspace,
      ...(directory.isSameEntry ? { directory } : {}),
    })
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"))
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"))
    })
  } finally {
    database.close()
  }
}

async function loadSavedDirectory(id: string) {
  try {
    const workspaces = await readSavedWorkspaces()
    return workspaces.find((workspace) => workspace.id === id)?.directory
  } catch {
    return undefined
  }
}

async function loadSavedAccessToken(id: string) {
  try {
    return (await readSavedWorkspaces()).find((workspace) => workspace.id === id)?.accessToken
  } catch {
    return undefined
  }
}

export function createBrowserWorkspacePicker(
  dependencies: BrowserWorkspacePickerDependencies = {
    pickDirectory: pickBrowserDirectory,
    pickFile: pickBrowserFile,
    createWorkspace: createServerWorkspace,
    ensureWorkspace: ensureServerWorkspace,
    loadAccessToken: loadSavedAccessToken,
    findWorkspace: findSavedWorkspace,
    rememberWorkspace: rememberSavedWorkspace,
    loadDirectory: loadSavedDirectory,
  },
) {
  const directories = new Map<string, BrowserWorkspaceDirectory>()
  const rememberWorkspace = async (
    workspace: BrowserWorkspaceIdentity,
    directory: BrowserWorkspaceDirectory,
    capabilityMustPersist: boolean,
  ) => {
    if (!dependencies.rememberWorkspace) {
      if (capabilityMustPersist) throw new Error("此浏览器无法保存分享工作区凭据。请允许此站点使用存储空间后重新选择工作区。")
      return
    }
    try {
      await dependencies.rememberWorkspace(workspace, directory)
    } catch {
      if (capabilityMustPersist) throw new Error("此浏览器无法保存分享工作区凭据。请允许此站点使用存储空间后重新选择工作区。")
    }
  }

  return {
    async ensureWorkspace(id: string, name: string) {
      if (!dependencies.ensureWorkspace) throw new Error("当前平台不支持恢复已保存的工作区。")
      const accessToken = await dependencies.loadAccessToken?.(id)
      if (!accessToken && dependencies.allowWorkspaceCapabilityReset === false) {
        throw new Error("此浏览器没有保存该工作区的凭据，请重新选择工作区目录。")
      }
      const workspace = await dependencies.ensureWorkspace(id, name, accessToken)
      const directory = await dependencies.loadDirectory?.(id).catch(() => undefined)
      if (directory) {
        directories.set(id, directory)
        await rememberWorkspace(workspace, directory, false)
      }
      return workspace
    },
    async selectWorkspace() {
      const directory = await dependencies.pickDirectory()
      if (!directory?.name.trim()) return undefined
      const name = directory.name.trim().slice(0, 160)
      const existing = await dependencies.findWorkspace?.(directory)
      let workspace: BrowserWorkspaceIdentity
      let capabilityPersistedBeforeCreate = false
      if (existing && dependencies.ensureWorkspace && (existing.accessToken || dependencies.allowWorkspaceCapabilityReset !== false)) {
        workspace = await dependencies.ensureWorkspace(existing.id, name, existing.accessToken)
      } else if (dependencies.allowWorkspaceCapabilityReset === false) {
        const prepared = await dependencies.prepareWorkspace?.(name)
        if (!prepared?.accessToken) throw new Error("无法安全准备访客工作区，请重试。")
        await rememberWorkspace(prepared, directory, true)
        capabilityPersistedBeforeCreate = true
        workspace = await dependencies.createWorkspace(name, prepared)
        if (workspace.id !== prepared.id || workspace.accessToken !== prepared.accessToken) {
          throw new Error("分享主机返回的工作区凭据与浏览器保存的凭据不一致。")
        }
      } else if (existing && !dependencies.ensureWorkspace) {
        workspace = existing
      } else {
        workspace = await dependencies.createWorkspace(name)
      }
      if (!capabilityPersistedBeforeCreate) {
        await rememberWorkspace(workspace, directory, dependencies.allowWorkspaceCapabilityReset === false && !existing?.accessToken)
      }
      directories.set(workspace.id, directory)
      return { id: workspace.id, name: workspace.name.slice(0, 160) }
    },
    async selectFile(workspaceID?: string) {
      let directory = workspaceID ? directories.get(workspaceID) : undefined
      if (!directory && workspaceID && dependencies.loadDirectory) {
        directory = await dependencies.loadDirectory(workspaceID).catch(() => undefined)
        if (directory) directories.set(workspaceID, directory)
      }
      return dependencies.pickFile(directory)
    },
  }
}

export function createBrowserSharedWorkspacePicker(
  dependencies: BrowserSharedWorkspacePickerDependencies = {
    pickDirectory: pickBrowserDirectory,
    pickFile: pickBrowserFile,
    createWorkspace: createPreparedServerWorkspace,
    prepareWorkspace: prepareServerWorkspace,
    ensureWorkspace: ensureServerWorkspace,
    loadAccessToken: loadSavedAccessToken,
    findWorkspace: findSavedWorkspace,
    rememberWorkspace: rememberSavedWorkspace,
    loadDirectory: loadSavedDirectory,
    allowWorkspaceCapabilityReset: false,
  },
) {
  return createBrowserWorkspacePicker({ ...dependencies, allowWorkspaceCapabilityReset: false })
}
