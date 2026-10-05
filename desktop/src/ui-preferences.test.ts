import { describe, expect, test } from "vitest"
import { isSharedUiPreferenceKey, parseSharedUiPreferences } from "./ui-preferences"

describe("shared UI preference schema", () => {
  test("accepts each permission mode and rejects unknown values", () => {
    for (const permissionMode of ["read_only", "workspace_write", "full_access"] as const) {
      expect(isSharedUiPreferenceKey("permissionMode")).toBe(true)
      expect(parseSharedUiPreferences({ protocolVersion: "v2", preferences: { permissionMode } }))
        .toEqual({ permissionMode })
    }

    expect(() => parseSharedUiPreferences({ protocolVersion: "v2", preferences: { permissionMode: "admin" } }))
      .toThrow("界面偏好")
  })
})
