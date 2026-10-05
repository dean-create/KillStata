import { describe, expect, test } from "vitest"
import { workspaceMode } from "./workspace-mode"

describe("workspace mode", () => {
  test("keeps ordinary browser development local by default", () => {
    expect(workspaceMode({ isTauri: false })).toBe("frontend")
  })

  test("allows an explicit browser connected-mode integration session", () => {
    expect(workspaceMode({ isTauri: false, requestedMode: "connected" })).toBe("connected")
  })

  test("keeps packaged Tauri in the same local frontend mode by default", () => {
    expect(workspaceMode({ isTauri: true })).toBe("frontend")
    expect(workspaceMode({ isTauri: true, requestedMode: "frontend" })).toBe("frontend")
  })

  test("allows an explicit Tauri connection mode", () => {
    expect(workspaceMode({ isTauri: true, requestedMode: "connected" })).toBe("connected")
  })
})
