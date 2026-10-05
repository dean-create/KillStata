import { describe, expect, test, vi } from "vitest"
import { createBrowserSharedWorkspacePicker, createBrowserWorkspacePicker } from "./workspace-picker"

describe("browser workspace picker", () => {
  test("reuses a share visitor's opaque workspace ID from the local browser handle without listing workspaces", async () => {
    const directory = { name: "visitor-study", isSameEntry: async (other: unknown) => other === directory }
    const saved: Array<{ id: string; name: string; directory: typeof directory }> = []
    const createWorkspace = vi.fn(async (name: string) => ({ id: "visitor-workspace-1", name }))
    const dependencies = {
      pickDirectory: vi.fn(async () => directory),
      pickFile: vi.fn(async () => undefined),
      createWorkspace,
      findWorkspace: vi.fn(async (candidate: typeof directory) => {
        for (const workspace of saved) {
          if (await workspace.directory.isSameEntry(candidate)) return { id: workspace.id, name: workspace.name }
        }
        return undefined
      }),
      rememberWorkspace: vi.fn(async (workspace: { id: string; name: string }, selected: typeof directory) => {
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
    expect(createWorkspace).toHaveBeenCalledOnce()
    expect(dependencies.findWorkspace).toHaveBeenCalledTimes(2)
    expect(dependencies.rememberWorkspace).toHaveBeenCalledTimes(2)
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
    const saved: Array<{ id: string; name: string; directory: typeof directory }> = []
    const findWorkspace = vi.fn(async (candidate: typeof directory) => {
      for (const workspace of saved) {
        if (await workspace.directory.isSameEntry(candidate)) return { id: workspace.id, name: workspace.name }
      }
      return undefined
    })
    const rememberWorkspace = vi.fn(async (workspace: { id: string; name: string }, selectedDirectory: typeof directory) => {
      saved.push({ ...workspace, directory: selectedDirectory })
    })
    const createWorkspace = vi.fn(async (name: string) => ({ id: "workspace-server-1", name }))
    const ensureWorkspace = vi.fn(async (id: string, name: string) => ({ id, name }))
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
    expect(ensureWorkspace).toHaveBeenCalledWith("workspace-server-1", "panel-study")
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
