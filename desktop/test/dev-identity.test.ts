import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

describe("Debug Desktop identity", () => {
  test("development launch uses a separate Tauri identity without changing release", () => {
    const release = JSON.parse(fs.readFileSync(path.join(desktopRoot, "src-tauri/tauri.conf.json"), "utf8"))
    const dev = JSON.parse(fs.readFileSync(path.join(desktopRoot, "src-tauri/tauri.dev.conf.json"), "utf8"))
    const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"))

    expect(release.identifier).toBe("com.killstata.desktop")
    expect(release.productName).toBe("KillStata")
    expect(dev.identifier).toBe("com.killstata.desktop.dev")
    expect(dev.productName).toBe("KillStata Dev")
    expect(dev.app.windows[0].title).toBe("KillStata Dev")
    expect(pkg.scripts["desktop:dev"]).toContain("--config src-tauri/tauri.dev.conf.json")
    expect(pkg.scripts["desktop:dev:bundle"]).toContain("tauri build --debug --bundles app")
    expect(pkg.scripts["desktop:dev:bundle"]).toContain("tauri.dev.conf.json")
    expect(pkg.scripts["desktop:dev:app"]).toContain("KillStata Dev.app")
    expect(pkg.scripts["macos:release"]).not.toContain("tauri.dev.conf.json")
  })

  test("registers the application exit command without exposing generic window close", () => {
    const capability = JSON.parse(fs.readFileSync(path.join(desktopRoot, "src-tauri/capabilities/default.json"), "utf8"))
    const nativeCommands = fs.readFileSync(path.join(desktopRoot, "src-tauri/src/main.rs"), "utf8")

    expect(capability.permissions).not.toContain("core:window:allow-close")
    expect(nativeCommands).toContain("fn exit_desktop")
    expect(nativeCommands).toContain("            exit_desktop,")
  })
})
