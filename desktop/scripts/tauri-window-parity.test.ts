import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function windowBounds(configuration: string) {
  const raw = await readFile(path.join(desktopRoot, "src-tauri", configuration), "utf8")
  const parsed = JSON.parse(raw) as { app?: { windows?: Array<{ minWidth?: number; minHeight?: number }> } }
  const window = parsed.app?.windows?.[0]
  if (!window) throw new Error(`${configuration} is missing its primary window configuration`)
  return window
}

describe("Tauri responsive parity bounds", () => {
  test.each(["tauri.conf.json", "tauri.dev.conf.json"])("allows the shared UI target viewport in %s", async (configuration) => {
    await expect(windowBounds(configuration)).resolves.toMatchObject({ minWidth: 720, minHeight: 600 })
  })
})
