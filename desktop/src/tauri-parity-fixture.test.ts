import { describe, expect, test } from "vitest"
import { createTauriParityFixtureAdapters, shouldUseTauriParityFixture } from "./tauri-parity-fixture"

describe("Tauri visual parity fixture", () => {
  test("requires a Tauri development build and explicit opt-in", () => {
    expect(shouldUseTauriParityFixture({ isTauri: true, isFixtureBuild: true, flag: "1" })).toBe(true)
    expect(shouldUseTauriParityFixture({ isTauri: false, isFixtureBuild: true, flag: "1" })).toBe(false)
    expect(shouldUseTauriParityFixture({ isTauri: true, isFixtureBuild: false, flag: "1" })).toBe(false)
    expect(shouldUseTauriParityFixture({ isTauri: true, isFixtureBuild: true, flag: "true" })).toBe(false)
  })

  test("provides in-memory credential, preference, and workspace adapters for a native visual run", async () => {
    const fixture = createTauriParityFixtureAdapters()

    await expect(fixture.engine.health()).resolves.toMatchObject({ status: "ready" })
    await expect(fixture.credentials.hasApiKey()).resolves.toBe(false)
    await expect(fixture.credentials.listProfiles?.()).resolves.toEqual({ profiles: [], defaultProfileId: null })
    await expect(fixture.runtimeDiagnostics.inspect()).resolves.toMatchObject({ python: { status: "warning" } })
    await expect(fixture.uiPreferences.load()).resolves.toEqual({
      theme: "dark",
      reasoningEffort: "high",
      permissionMode: "read_only",
    })
    await expect(fixture.uiPreferences.save("permissionMode", "full_access")).resolves.toBe(true)
    await expect(fixture.uiPreferences.load()).resolves.toMatchObject({ permissionMode: "full_access" })
    await expect(fixture.workspaceStore.load()).resolves.toBeUndefined()
    expect(fixture.workspaceStore.isEnabled?.()).toBe(false)
  })
})
