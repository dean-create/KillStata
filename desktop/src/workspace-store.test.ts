import { describe, expect, test } from "vitest"
import {
  emptyWorkspaceSnapshot,
  createLocalWorkspaceStore,
  normalizeWorkspaceSnapshot,
  workspaceIDFromPath,
} from "./workspace-store"

describe("workspace history store", () => {
  test("keeps a stable opaque id for the same path and separates different paths", () => {
    expect(workspaceIDFromPath("/Users/cw/Documents/policy-lab")).toBe(workspaceIDFromPath("/Users/cw/Documents/policy-lab"))
    expect(workspaceIDFromPath("/Users/cw/Documents/policy-lab")).not.toBe(workspaceIDFromPath("/Users/cw/Documents/other-lab"))
    expect(workspaceIDFromPath("/Users/cw/Documents/policy-lab")).not.toContain("policy-lab")
  })

  test("normalizes a snapshot and marks interrupted work as interrupted", () => {
    const snapshot = normalizeWorkspaceSnapshot({
      version: 1,
      activeWorkspaceID: "workspace-a",
      workspaces: [{
        id: "workspace-a",
        name: "政策研究",
        lastOpenedAt: 1,
        researches: [{
          id: 1,
          title: "OLS",
          messages: [{ kind: "user", id: 1, text: "估计处理效应" }],
          dataset: { name: "study.csv", format: "CSV", bytes: 12 },
          permissionMode: "read_only",
          workbookSheetNames: [],
          resultDocument: "",
          resultExportable: false,
          runStatus: "running",
          runID: "run-1",
        }, {
          id: 2,
          title: "等待回答",
          messages: [{ kind: "user", id: 2, text: "等待回答" }],
          workbookSheetNames: [],
          resultDocument: "",
          resultExportable: false,
          runStatus: "waiting_for_user",
          runID: "run-2",
        }],
      }],
    })
    expect(snapshot?.workspaces.some((workspace) => workspace.id === "__unassigned__")).toBe(true)
    expect(snapshot?.workspaces.find((workspace) => workspace.id === "workspace-a")?.researches[0]?.runStatus).toBe("interrupted")
    expect(snapshot?.workspaces.find((workspace) => workspace.id === "workspace-a")?.researches[0]?.runID).toBeUndefined()
    expect(snapshot?.workspaces.find((workspace) => workspace.id === "workspace-a")?.researches[0]?.permissionMode).toBe("read_only")
    expect(snapshot?.workspaces.find((workspace) => workspace.id === "workspace-a")?.researches[1]?.runStatus).toBe("interrupted")
    expect(snapshot?.workspaces.find((workspace) => workspace.id === "workspace-a")?.researches[1]?.runID).toBeUndefined()
  })

  test("does not load or save history until explicitly enabled", async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } as unknown as Storage
    const store = createLocalWorkspaceStore(storage)
    const snapshot = emptyWorkspaceSnapshot()
    await store.save(snapshot)
    await expect(store.load()).resolves.toBeUndefined()
    await store.setEnabled?.(true)
    await store.save(snapshot)
    await expect(store.load()).resolves.toEqual(snapshot)
    await store.setEnabled?.(false)
    await expect(store.load()).resolves.toBeUndefined()
    expect(values.has("killstata-desktop-workspaces")).toBe(false)
  })
  test("round-trips application history without writing to a workspace path", async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } as unknown as Storage
    const store = createLocalWorkspaceStore(storage)
    await store.setEnabled?.(true)
    const snapshot = emptyWorkspaceSnapshot()
    snapshot.workspaces[0].researches.push({
      id: 1,
      title: "本地研究",
      messages: [{ kind: "user", id: 1, text: "检查就业变化" }],
      dataset: { name: "employment.csv", format: "CSV", bytes: 10 },
      workbookSheetNames: [],
      resultDocument: "结果",
      resultExportable: true,
      runStatus: "completed",
      permissionMode: "full_access",
    })
    await store.save(snapshot)
    await expect(store.load()).resolves.toEqual(snapshot)
    expect([...values.values()][0]).not.toContain("/Users/")
  })

  test("drops invalid permission modes while keeping the rest of a legacy research snapshot", () => {
    const snapshot = normalizeWorkspaceSnapshot({
      version: 1,
      activeWorkspaceID: "__unassigned__",
      workspaces: [{
        id: "__unassigned__",
        name: "未归档研究",
        lastOpenedAt: 1,
        researches: [{
          id: 1,
          title: "旧权限值",
          messages: [{ kind: "user", id: 1, text: "继续研究" }],
          workbookSheetNames: [],
          resultDocument: "",
          resultExportable: false,
          runStatus: "idle",
          permissionMode: "admin",
        }],
      }],
    })

    expect(snapshot?.workspaces[0]?.researches[0]?.permissionMode).toBeUndefined()
    expect(snapshot?.workspaces[0]?.researches[0]?.title).toBe("旧权限值")
  })
})
