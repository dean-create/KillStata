import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { readSourceUnit } from "../helpers/read-source"

const source = (...segments: string[]) => fs.readFileSync(path.join(process.cwd(), "src", ...segments), "utf-8")

describe("OpenCode residue removal", () => {
  test("runtime bootstrap has no plugin, VCS, or file watcher startup", () => {
    const bootstrap = source("project", "bootstrap.ts")

    expect(bootstrap).not.toContain("Plugin")
    expect(bootstrap).not.toContain("Vcs")
    expect(bootstrap).not.toContain("FileWatcher")
  })

  test("agent runtime does not import or trigger external plugins", () => {
    for (const file of [
      "session/llm.ts",
      "session/compaction.ts",
      "runtime/turn-assembler.ts",
      "tool/registry.ts",
      "provider/auth.ts",
    ]) {
      const content = source(...file.split("/"))
      expect(content).not.toContain("Plugin")
      expect(content).not.toContain("@killstata/plugin")
    }
    // session/prompt 已从单文件拆成目录，用 readSourceUnit 一次覆盖它的全部子模块
    const promptUnit = readSourceUnit("session/prompt")
    expect(promptUnit).not.toContain("Plugin")
    expect(promptUnit).not.toContain("@killstata/plugin")
  })

  test("project identity and API no longer depend on Git or VCS", () => {
    expect(source("project", "project.ts")).not.toContain("git rev-")
    expect(source("server", "server.ts")).not.toContain('"/vcs"')
    expect(source("server", "server.ts")).not.toContain("Vcs")
  })

  test("file reads no longer calculate or expose source diffs", () => {
    const file = source("file", "index.ts")

    expect(file).not.toContain("git diff")
    expect(file).not.toContain("structuredPatch")
    expect(file).not.toContain("formatPatch")
    expect(file).not.toContain("diff: z.string()")
  })

  test("edit and write keep working without rendering a patch preview", () => {
    for (const file of ["tool/edit.ts", "tool/write.ts", "cli/cmd/tui/routes/session/index.tsx"]) {
      const content = source(...file.split("/"))
      expect(content).not.toContain("createTwoFilesPatch")
      expect(content).not.toContain("metadata.diff")
    }
  })

  test("configuration no longer loads executable plugins or plugin dependencies", () => {
    const config = source("config", "config.ts")
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"))

    expect(config).not.toContain("loadPlugin")
    expect(config).not.toContain("@killstata/plugin")
    expect(config).not.toContain("result.plugin")
    expect(packageJson.dependencies?.["@killstata/plugin"]).toBeUndefined()
    expect(packageJson.dependencies?.["@parcel/watcher"]).toBeUndefined()
  })

  test("retired plugin, VCS, and watcher modules are moved out of production source", () => {
    for (const retired of ["plugin", "project/vcs.ts", "file/watcher.ts"]) {
      expect(fs.existsSync(path.join(process.cwd(), "src", retired))).toBe(false)
    }
  })
})
