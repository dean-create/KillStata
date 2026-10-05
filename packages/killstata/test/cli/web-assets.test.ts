import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { copyWebAssets } from "../../script/web-assets"

describe("published KillStata Web assets", () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  test("copies the validated Web bundle beside the installed CLI package", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "killstata-web-assets-"))
    const source = path.join(root, "source")
    const packageDirectory = path.join(root, "package")
    await mkdir(path.join(source, "assets"), { recursive: true })
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(path.join(source, "index.html"), "<div>KillStata</div>")
    await writeFile(path.join(source, "assets", "app.js"), "window.app = true")
    await writeFile(path.join(source, "assets", "app.css"), "body { color: black }")

    const destination = copyWebAssets(source, packageDirectory)

    expect(await readFile(path.join(destination, "index.html"), "utf8")).toContain("KillStata")
    expect(await readFile(path.join(destination, "assets", "app.js"), "utf8")).toContain("window.app")
    expect(await readFile(path.join(destination, "assets", "app.css"), "utf8")).toContain("color: black")
  })

  test("rejects an incomplete build before release packing", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "killstata-web-assets-missing-"))
    const source = path.join(root, "source")
    const packageDirectory = path.join(root, "package")
    await mkdir(source, { recursive: true })
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(path.join(source, "index.html"), "<div>KillStata</div>")

    expect(() => copyWebAssets(source, packageDirectory)).toThrow("Web 构建产物缺少 index.html 或 JS/CSS 资源")
  })
})
