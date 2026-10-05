import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

describe("primary-agent reminders", () => {
  test("does not reintroduce explorer or plan-mode instructions into model context", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "session", "prompt", "reminder.ts"), "utf-8")

    expect(source).not.toContain('"explorer"')
    expect(source).not.toContain("KILLSTATA_EXPERIMENTAL_PLAN_MODE")
    expect(source).not.toContain("plan_enter")
    expect(source).not.toContain("plan_exit")
  })
})
