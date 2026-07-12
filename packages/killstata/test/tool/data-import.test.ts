import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

describe("tool.data_import", () => {
  test("includes DTA encoding fallback logic", () => {
    const sourcePath = path.join(process.cwd(), "src", "tool", "data-import.ts")
    const source = fs.readFileSync(sourcePath, "utf-8")
    expect(source).toContain('"gbk"')
    expect(source).toContain('"latin1"')
    expect(source).toContain('_source_encoding')
  })
})
