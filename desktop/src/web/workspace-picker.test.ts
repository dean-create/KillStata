import { describe, expect, test, vi } from "vitest"
import { createBrowserSharedWorkspacePicker, createBrowserWorkspacePicker } from "./workspace-picker"

function installMemoryIndexedDB() {
  const rows = new Map<string, Record<string, unknown>>()
  type MemoryObjectStore = {
    put(value: Record<string, unknown>): IDBRequest<IDBValidKey>
    getAll(): IDBRequest<Record<string, unknown>[]>
  }
  type MemoryTransaction = { oncomplete?: () => void; objectStore: () => MemoryObjectStore }
  let activeTransaction: MemoryTransaction | undefined
  const objectStore: MemoryObjectStore = {
    put(value: Record<string, unknown>) {
      rows.set(String(value.id), structuredClone(value))
      queueMicrotask(() => activeTransaction?.oncomplete?.())
      return {} as IDBRequest<IDBValidKey>
    },
    getAll() {
      const request: IDBRequest<Record<string, unknown>[]> = { result: [...rows.values()] } as IDBRequest<Record<string, unknown>[]>
      queueMicrotask(() => request.onsuccess?.(new Event("success") as unknown as Event))
      return request
    },
  }
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const transaction: MemoryTransaction = { objectStore: () => objectStore }
      activeTransaction = transaction
      return transaction
    },
    close: () => {},
  }
  const indexedDB = {
    open: () => {
      const request = { result: database } as unknown as IDBOpenDBRequest
      queueMicrotask(() => request.onsuccess?.(new Event("success") as unknown as Event))
      return request
    },
  } as unknown as IDBFactory
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: indexedDB })
  return {
    rows,
    restore() {
      if (previous) Object.defineProperty(globalThis, "indexedDB", previous)
      else Reflect.deleteProperty(globalThis, "indexedDB")
    },
  }
}

describe("browser workspace picker", () => {
  test("reuses a share visitor's opaque workspace ID from the local browser handle without listing workspaces", async () => {
    const directory = { name: "visitor-study", isSameEntry: async (other: unknown) => other === directory }
    const saved: Array<{ id: string; name: string; accessToken?: string; directory: typeof directory }> = []
    const token = "visitor-capability-token-012345678901234567890123"
    const prepareWorkspace = vi.fn(async (name: string) => ({ id: "visitor-workspace-1", name, accessToken: token }))
    const createWorkspace = vi.fn(async (_name: string, prepared?: { id: string; name: string; accessToken?: string }) => prepared!)
    const ensureWorkspace = vi.fn(async (id: string, name: string, accessToken?: string) => ({ id, name, accessToken }))
    const dependencies = {
      pickDirectory: vi.fn(async () => directory),
      pickFile: vi.fn(async () => undefined),
      prepareWorkspace,
      createWorkspace,
      ensureWorkspace,
      findWorkspace: vi.fn(async (candidate: typeof directory) => {
        for (const workspace of saved) {
          if (await workspace.directory.isSameEntry(candidate)) return { id: workspace.id, name: workspace.name, accessToken: workspace.accessToken }
        }
        return undefined
      }),
      rememberWorkspace: vi.fn(async (workspace: { id: string; name: string; accessToken?: string }, selected: typeof directory) => {
        saved.push({ ...workspace, directory: selected })
      }),
      loadDirectory: vi.fn(async (id: string) => saved.find((workspace) => workspace.id === id)?.directory),
    }

    const firstPicker = createBrowserSharedWorkspacePicker(dependencies)
    const first = await firstPicker.selectWorkspace()
    const pickerAfterReload = createBrowserSharedWorkspacePicker(dependencies)
    const restored = await pickerAfterReload.selectWorkspace()

    expect(first).toEqual({ id: "visitor-workspace-1", name: "visitor-study" })
    expect(restored).toEqual(first)
    expect(prepareWorkspace).toHaveBeenCalledOnce()
    expect(createWorkspace).toHaveBeenCalledOnce()
    expect(createWorkspace).toHaveBeenCalledWith("visitor-study", { id: "visitor-workspace-1", name: "visitor-study", accessToken: token })
    expect(ensureWorkspace).toHaveBeenCalledWith("visitor-workspace-1", "visitor-study", token)
    expect(dependencies.findWorkspace).toHaveBeenCalledTimes(2)
    expect(dependencies.rememberWorkspace).toHaveBeenCalledTimes(2)
  })

  test("rebinds a restored share workspace with the capability saved in this browser", async () => {
    const token = "visitor-capability-token-012345678901234567890123"
    const ensureWorkspace = vi.fn(async (id: string, name: string, accessToken?: string) => ({ id, name, accessToken }))
    const picker = createBrowserSharedWorkspacePicker({
      pickDirectory: async () => undefined,
      pickFile: async () => undefined,
      createWorkspace: async (name) => ({ id: "unused", name, accessToken: token }),
      ensureWorkspace,
      loadAccessToken: async (id) => id === "saved-workspace" ? token : undefined,
    })

    await picker.ensureWorkspace("saved-workspace", "saved-study")

    expect(ensureWorkspace).toHaveBeenCalledWith("saved-workspace", "saved-study", token)
  })

  test("persists a share capability when the insecure-LAN directory fallback has no durable handle", async () => {
    const token = "visitor-capability-token-012345678901234567890123"
    const storage = installMemoryIndexedDB()
    const previousFetch = globalThis.fetch
    const previousDirectoryPicker = Object.getOwnPropertyDescriptor(globalThis, "showDirectoryPicker")
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      requests.push({ path, body })
      return Response.json({
        protocolVersion: "v2",
        id: "lan-workspace-1",
        name: body.name ?? "visitor-study",
        accessToken: body.accessToken ?? token,
      }, { status: path.endsWith("/ensure") ? 200 : 201 })
    })
    Object.defineProperty(globalThis, "showDirectoryPicker", { configurable: true, value: undefined })
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, "files", {
        configurable: true,
        value: [{ webkitRelativePath: "visitor-study/sample.csv" }],
      })
      this.dispatchEvent(new Event("change"))
    })

    try {
      const picker = createBrowserSharedWorkspacePicker()
      await picker.selectWorkspace()
      const pickerAfterReload = createBrowserSharedWorkspacePicker()
      await pickerAfterReload.ensureWorkspace("lan-workspace-1", "visitor-study")

      expect(requests.map(({ path }) => path)).toEqual([
        "/api/v2/workspaces/prepare",
        "/api/v2/workspaces",
        "/api/v2/workspaces/ensure",
      ])
      expect(requests[1]?.body).toMatchObject({ id: "lan-workspace-1", name: "visitor-study", accessToken: token })
      expect(requests[2]?.body).toMatchObject({ id: "lan-workspace-1", name: "visitor-study", accessToken: token })
    } finally {
      click.mockRestore()
      globalThis.fetch = previousFetch
      if (previousDirectoryPicker) Object.defineProperty(globalThis, "showDirectoryPicker", previousDirectoryPicker)
      else Reflect.deleteProperty(globalThis, "showDirectoryPicker")
      storage.restore()
    }
  })

  test("rejects a new share workspace when its capability cannot be persisted", async () => {
    const rememberWorkspace = vi.fn(async () => { throw new Error("IndexedDB write failed") })
    const prepareWorkspace = vi.fn(async (name: string) => ({ id: "unrestorable-workspace", name, accessToken: "visitor-capability-token-012345678901234567890123" }))
    const createWorkspace = vi.fn(async (_name: string, prepared?: { id: string; name: string; accessToken?: string }) => prepared!)
    const picker = createBrowserSharedWorkspacePicker({
      pickDirectory: async () => ({ name: "visitor-study" }),
      pickFile: async () => undefined,
      prepareWorkspace,
      createWorkspace,
      rememberWorkspace,
    })

    await expect(picker.selectWorkspace()).rejects.toThrow("此浏览器无法保存分享工作区凭据")
    expect(prepareWorkspace).toHaveBeenCalledOnce()
    expect(createWorkspace).not.toHaveBeenCalled()
    expect(rememberWorkspace).toHaveBeenCalledOnce()
  })

  test("opens later file selection in the directory chosen for that workspace", async () => {
    const directory = { name: "panel-study" }
    const file = new File(["a,b\n1,2\n"], "sample.csv", { type: "text/csv" })
    const pickDirectory = vi.fn(async () => directory)
    const pickFile = vi.fn(async () => file)
    const createWorkspace = vi.fn(async (name: string) => ({ id: "workspace-server-1", name }))
    const adapter = createBrowserWorkspacePicker({ pickDirectory, pickFile, createWorkspace })

    const workspace = await adapter.selectWorkspace()

    expect(workspace).toEqual({ id: "workspace-server-1", name: "panel-study" })
    expect(createWorkspace).toHaveBeenCalledWith("panel-study")
    await expect(adapter.selectFile(workspace?.id)).resolves.toBe(file)
    expect(pickFile).toHaveBeenCalledWith(directory)
  })

  test("reuses the same opaque workspace when the same directory is selected after reload", async () => {
    const directory = { name: "panel-study", isSameEntry: async (other: unknown) => other === directory }
    const accessToken = "browser-workspace-capability-token-0123456789"
    const saved: Array<{ id: string; name: string; accessToken?: string; directory: typeof directory }> = []
    const findWorkspace = vi.fn(async (candidate: typeof directory) => {
      for (const workspace of saved) {
        if (await workspace.directory.isSameEntry(candidate)) return { id: workspace.id, name: workspace.name, accessToken: workspace.accessToken }
      }
      return undefined
    })
    const rememberWorkspace = vi.fn(async (workspace: { id: string; name: string; accessToken?: string }, selectedDirectory: typeof directory) => {
      saved.push({ ...workspace, directory: selectedDirectory })
    })
    const createWorkspace = vi.fn(async (name: string) => ({ id: "workspace-server-1", name, accessToken }))
    const ensureWorkspace = vi.fn(async (id: string, name: string, token?: string) => ({ id, name, accessToken: token }))
    const dependencies = {
      pickDirectory: vi.fn(async () => directory),
      pickFile: vi.fn(async () => undefined),
      createWorkspace,
      findWorkspace,
      rememberWorkspace,
      ensureWorkspace,
      loadDirectory: vi.fn(async () => directory),
    }

    const firstPicker = createBrowserWorkspacePicker(dependencies)
    const first = await firstPicker.selectWorkspace()
    const pickerAfterReload = createBrowserWorkspacePicker(dependencies)
    const reopened = await pickerAfterReload.selectWorkspace()

    expect(first?.id).toBe("workspace-server-1")
    expect(reopened).toEqual(first)
    expect(createWorkspace).toHaveBeenCalledOnce()
    expect(ensureWorkspace).toHaveBeenCalledWith("workspace-server-1", "panel-study", accessToken)
  })

  test("restores a saved directory handle before opening a workspace file picker", async () => {
    const directory = { name: "panel-study", isSameEntry: async (_other: unknown) => true }
    const pickFile = vi.fn(async (startIn?: typeof directory) => {
      expect(startIn).toBe(directory)
      return new File(["a,b\n1,2\n"], "sample.csv", { type: "text/csv" })
    })
    const loadDirectory = vi.fn(async (id: string) => id === "workspace-server-1" ? directory : undefined)
    const adapter = createBrowserWorkspacePicker({
      pickDirectory: async () => undefined,
      pickFile,
      createWorkspace: async (name) => ({ id: "new-workspace", name }),
      findWorkspace: async () => undefined,
      rememberWorkspace: async () => {},
      ensureWorkspace: async (id, name) => ({ id, name }),
      loadDirectory,
    })

    await expect(adapter.selectFile("workspace-server-1")).resolves.toMatchObject({ name: "sample.csv" })
    expect(loadDirectory).toHaveBeenCalledWith("workspace-server-1")
    expect(pickFile).toHaveBeenCalledWith(directory)
  })
})
