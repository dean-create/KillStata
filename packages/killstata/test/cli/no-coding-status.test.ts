import { expect, test } from "bun:test"
import fs from "fs"
import path from "path"

test("the TUI no longer keeps LSP or formatter status state", () => {
  const syncSource = fs.readFileSync(path.join(process.cwd(), "src", "cli", "cmd", "tui", "context", "sync.tsx"), "utf-8")
  const statusSource = fs.readFileSync(
    path.join(process.cwd(), "src", "cli", "cmd", "tui", "component", "dialog-status.tsx"),
    "utf-8",
  )

  expect(syncSource).not.toContain("LspStatus")
  expect(syncSource).not.toContain('case "lsp.updated"')
  expect(syncSource).not.toContain("client.formatter.status")
  expect(statusSource).not.toContain("sync.data.lsp")
  expect(statusSource).not.toContain("sync.data.formatter")
})
