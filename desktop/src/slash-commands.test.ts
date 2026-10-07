import { describe, expect, test } from "vitest"
import { desktopSlashCommandCatalog, normalizeSlashCommand, parseSlashInvocation } from "./slash-commands"

describe("Desktop TUI 斜杠命令目录", () => {
  test("公开 TUI 的全部命令与别名", () => {
    const catalog = desktopSlashCommandCatalog()
    const names = catalog.flatMap((command) => [command.name, ...(command.aliases ?? [])])
    expect(names).toEqual(expect.arrayContaining([
      "new", "clear", "config", "connect", "context", "copy", "doctor", "exit", "quit", "q",
      "export", "help", "model", "models", "reasoning", "rename", "sessions", "resume", "continue",
      "thinking", "toggle-thinking", "timestamps", "toggle-timestamps", "undo", "redo", "compact", "summarize", "themes",
    ]))
    expect(catalog.map((command) => command.name)).toEqual(expect.arrayContaining([
      "context", "sessions", "new", "model", "config", "themes", "help", "exit",
      "rename", "compact", "undo", "redo", "timestamps", "thinking", "copy", "export",
    ]))
  })

  test("严格解析命令名和参数，不把未知输入当成命令", () => {
    expect(normalizeSlashCommand("/reasoning high")).toEqual({ name: "reasoning", arguments: "high" })
    expect(normalizeSlashCommand("/doctor inspect\nsecond line")).toEqual({ name: "doctor", arguments: "inspect\nsecond line" })
    expect(parseSlashInvocation("/workflow inspect\nsecond line")).toEqual({ name: "workflow", arguments: "inspect\nsecond line" })
    expect(normalizeSlashCommand("/unknown anything")).toBeUndefined()
    expect(normalizeSlashCommand("普通研究问题")).toBeUndefined()
  })
})
