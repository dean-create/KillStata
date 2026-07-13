import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

describe("session instructions", () => {
  test("does not load Claude Code instruction files", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "session", "instruction.ts"), "utf-8")

    expect(source).not.toContain("CLAUDE.md")
    expect(source).not.toContain('".claude"')
  })
})
