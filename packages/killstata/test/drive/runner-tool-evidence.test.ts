import { describe, expect, test } from "bun:test"
import { shouldCaptureDriveToolArgs } from "./runner"

describe("drive tool evidence", () => {
  test("captures mutation parameters needed by behavioral assertions", () => {
    expect(shouldCaptureDriveToolArgs("data_preprocess")).toBe(true)
    expect(shouldCaptureDriveToolArgs("panel_fe_regression")).toBe(true)
    expect(shouldCaptureDriveToolArgs("data_import")).toBe(true)
    expect(shouldCaptureDriveToolArgs("pipeline")).toBe(false)
  })
})
