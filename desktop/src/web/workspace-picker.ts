export type BrowserWorkspaceDirectory = {
  name: string
  isSameEntry?: (other: BrowserWorkspaceDirectory) => Promise<boolean>
}

type SavedBrowserWorkspace = { id: string; name: string; directory: BrowserWorkspaceDirectory }

type BrowserWorkspacePickerDependencies = {
  pickDirectory(): Promise<BrowserWorkspaceDirectory | undefined>
  pickFile(directory?: BrowserWorkspaceDirectory): Promise<File | undefined>
  createWorkspace(name: string): Promise<{ id: string; name: string }>
  findWorkspace?(directory: BrowserWorkspaceDirectory): Promise<{ id: string; name: string } | undefined>
  rememberWorkspace?(workspace: { id: string; name: string }, directory: BrowserWorkspaceDirectory): Promise<void>
  ensureWorkspace?(id: string, name: string): Promise<{ id: string; name: string }>
  loadDirectory?(id: string): Promise<BrowserWorkspaceDirectory | undefined>
}

export type BrowserSharedWorkspacePickerDependencies = Omit<BrowserWorkspacePickerDependencies, "ensureWorkspace">

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

async function ensureServerWorkspace(id: string, name: string) {
  return requestServerWorkspace("/api/v2/workspaces/ensure", { id, name }, id)
}

async function requestServerWorkspace(path: string, body: Record<string, string>, expectedID?: string) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => undefined) as { id?: unknown; name?: unknown; message?: unknown } | undefined
  if (!response.ok || !result || typeof result.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(result.id)
    || result.id === "__unassigned__" || expectedID && result.id !== expectedID || typeof result.name !== "string") {
    throw new Error(typeof result?.message === "string" ? result.message : "无法在本机创建工作区，请重试。")
  }
  return { id: result.id, name: result.name }
}

function validSavedWorkspace(value: unknown): value is SavedBrowserWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const workspace = value as Record<string, unknown>
  const directory = workspace.directory as BrowserWorkspaceDirectory | undefined
  return typeof workspace.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(workspace.id)
    && workspace.id !== "__unassigned__" && typeof workspace.name === "string" && workspace.name.length <= 160
    && Boolean(directory && typeof directory.name === "string" && typeof directory.isSameEntry === "function")
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
      if (await workspace.directory.isSameEntry?.(directory)) return { id: workspace.id, name: workspace.name }
    }
  } catch {
    // Browser storage can be disabled; continue with an in-memory workspace for this page.
  }
  return undefined
}

async function rememberSavedWorkspace(workspace: { id: string; name: string }, directory: BrowserWorkspaceDirectory) {
  if (!directory.isSameEntry) return
  const database = await openWorkspaceDatabase()
  try {
    const transaction = database.transaction(WORKSPACE_OBJECT_STORE, "readwrite")
    transaction.objectStore(WORKSPACE_OBJECT_STORE).put({ ...workspace, directory })
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

export function createBrowserWorkspacePicker(
  dependencies: BrowserWorkspacePickerDependencies = {
    pickDirectory: pickBrowserDirectory,
    pickFile: pickBrowserFile,
    createWorkspace: createServerWorkspace,
    findWorkspace: findSavedWorkspace,
    rememberWorkspace: rememberSavedWorkspace,
    ensureWorkspace: ensureServerWorkspace,
    loadDirectory: loadSavedDirectory,
  },
) {
  const directories = new Map<string, BrowserWorkspaceDirectory>()

  return {
    async selectWorkspace() {
      const directory = await dependencies.pickDirectory()
      if (!directory?.name.trim()) return undefined
      const name = directory.name.trim().slice(0, 160)
      const existing = await dependencies.findWorkspace?.(directory)
      const workspace = existing && dependencies.ensureWorkspace
        ? await dependencies.ensureWorkspace(existing.id, name)
        : existing ?? await dependencies.createWorkspace(name)
      directories.set(workspace.id, directory)
      await dependencies.rememberWorkspace?.(workspace, directory).catch(() => {})
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
    createWorkspace: createServerWorkspace,
    findWorkspace: findSavedWorkspace,
    rememberWorkspace: rememberSavedWorkspace,
    loadDirectory: loadSavedDirectory,
  },
) {
  return createBrowserWorkspacePicker(dependencies)
}
