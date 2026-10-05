import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

const TUI_ROOT = path.join(process.cwd(), "src", "cli", "cmd", "tui")

function read(file: string) {
  return fs.readFileSync(path.join(TUI_ROOT, file), "utf-8")
}

describe("local /context command", () => {
  test("registers at app scope and opens the context dialog", () => {
    const app = read("app.tsx")
    expect(app).toContain('value: "app.context"')
    expect(app).toContain('name: "context"')
    expect(app).toContain("<DialogContext />")
  })

  test("direct /context input is handled locally instead of sent as a model command", () => {
    const prompt = read("component/prompt/index.tsx")
    expect(prompt).toContain('trimmed.match(/^\\/context(?:\\s+.*)?$/i)')
    expect(prompt).toContain('command.trigger("app.context")')
  })

  test("context command is not a server command", () => {
    const command = fs.readFileSync(path.join(process.cwd(), "src", "command", "index.ts"), "utf-8")
    expect(command).not.toContain('name: "context"')
  })
})
