import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import type { BunFile } from "bun"
import path from "path"
import fs from "fs"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { Ripgrep } from "./ripgrep"
import fuzzysort from "fuzzysort"
import { Global } from "../global"

export namespace File {
  const log = Log.create({ service: "file" })

  export const Node = z
    .object({
      name: z.string(),
      path: z.string(),
      absolute: z.string(),
      type: z.enum(["file", "directory"]),
      ignored: z.boolean(),
    })
    .meta({ ref: "FileNode" })
  export type Node = z.infer<typeof Node>

  export const Content = z
    .object({
      type: z.literal("text"),
      content: z.string(),
      encoding: z.literal("base64").optional(),
      mimeType: z.string().optional(),
    })
    .meta({ ref: "FileContent" })
  export type Content = z.infer<typeof Content>

  async function shouldEncode(file: BunFile): Promise<boolean> {
    const type = file.type?.toLowerCase()
    if (!type || type.startsWith("text/") || type.includes("charset=")) return false
    const [top, rest = ""] = type.split("/", 2)
    if (["image", "audio", "video", "font", "model", "multipart"].includes(top)) return true
    const subtype = rest.split(";", 1)[0]
    return [
      "zip",
      "gzip",
      "bzip",
      "compressed",
      "binary",
      "pdf",
      "msword",
      "powerpoint",
      "excel",
      "ogg",
      "exe",
      "dmg",
      "iso",
      "rar",
    ].some((mark) => subtype.includes(mark))
  }

  export const Event = {
    Edited: BusEvent.define("file.edited", z.object({ file: z.string() })),
  }

  const state = Instance.state(async () => {
    type Entry = { files: string[]; dirs: string[] }
    let cache: Entry = { files: [], dirs: [] }
    let fetching = false
    let lastRefreshed = 0
    // File.refresh 节流：30s 内不重复全树扫描。避免模型每次模糊搜索都触发 rg --files 把 CPU 打满。
    const REFRESH_THROTTLE_MS = 30_000
    const isGlobalHome = Instance.directory === Global.Path.home && Instance.project.id === "global"

    const refresh = async (result: Entry) => {
      if (Instance.directory === path.parse(Instance.directory).root) return
      fetching = true
      if (isGlobalHome) {
        const dirs = new Set<string>()
        const ignored = new Set(["Library", "AppData"])
        const ignoredNested = new Set(["node_modules", "dist", "build", "target", "vendor"])
        for (const entry of await fs.promises
          .readdir(Instance.directory, { withFileTypes: true })
          .catch(() => [] as fs.Dirent[])) {
          if (!entry.isDirectory() || entry.name.startsWith(".") || ignored.has(entry.name)) continue
          dirs.add(entry.name + "/")
          const base = path.join(Instance.directory, entry.name)
          for (const child of await fs.promises.readdir(base, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
            if (child.isDirectory() && !child.name.startsWith(".") && !ignoredNested.has(child.name)) {
              dirs.add(entry.name + "/" + child.name + "/")
            }
          }
        }
        result.dirs = Array.from(dirs).toSorted()
      } else {
        const dirs = new Set<string>()
        // maxDepth 限制全树递归深度——fuzzysort 用目录/文件名匹配，4 层足够；
        // 配合 Ripgrep 默认忽略清单（node_modules/build/...），把全树扫描的 CPU 占用拉回安全水位。
        for await (const file of Ripgrep.files({ cwd: Instance.directory, maxDepth: 4 })) {
          result.files.push(file)
          for (let current = file; ; ) {
            const directory = path.dirname(current)
            if (directory === "." || directory === current) break
            current = directory
            if (dirs.has(directory)) continue
            dirs.add(directory)
            result.dirs.push(directory + "/")
          }
        }
      }
      cache = result
      fetching = false
      lastRefreshed = Date.now()
    }
    void refresh(cache)

    return {
      async files() {
        // 缓存为空或超过节流窗口才重扫，避免每次模糊搜索都触发 rg --files。
        if (!fetching && (cache.files.length === 0 || Date.now() - lastRefreshed > REFRESH_THROTTLE_MS))
          void refresh({ files: [], dirs: [] })
        return cache
      },
    }
  })

  export function init() {
    state()
  }

  export async function read(file: string): Promise<Content> {
    using _ = log.time("read", { file })
    const full = path.join(Instance.directory, file)
    if (!Instance.containsPath(full)) throw new Error("Access denied: path escapes project directory")
    const bunFile = Bun.file(full)
    if (!(await bunFile.exists())) return { type: "text", content: "" }
    if (await shouldEncode(bunFile)) {
      const content = Buffer.from(await bunFile.arrayBuffer().catch(() => new ArrayBuffer(0))).toString("base64")
      return { type: "text", content, mimeType: bunFile.type || "application/octet-stream", encoding: "base64" }
    }
    return {
      type: "text",
      content: await bunFile
        .text()
        .catch(() => "")
        .then((text) => text.trim()),
    }
  }

  export async function list(dir?: string) {
    const resolved = dir ? path.join(Instance.directory, dir) : Instance.directory
    if (!Instance.containsPath(resolved)) throw new Error("Access denied: path escapes project directory")
    const nodes: Node[] = []
    for (const entry of await fs.promises.readdir(resolved, { withFileTypes: true }).catch(() => [])) {
      if ([".git", ".DS_Store"].includes(entry.name)) continue
      const absolute = path.join(resolved, entry.name)
      nodes.push({
        name: entry.name,
        path: path.relative(Instance.directory, absolute),
        absolute,
        type: entry.isDirectory() ? "directory" : "file",
        ignored: false,
      })
    }
    return nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1))
  }

  export async function search(input: { query: string; limit?: number; dirs?: boolean; type?: "file" | "directory" }) {
    const query = input.query.trim()
    const limit = input.limit ?? 100
    const kind = input.type ?? (input.dirs === false ? "file" : "all")
    const result = await state().then((value) => value.files())
    const hidden = (item: string) =>
      item
        .replaceAll("\\", "/")
        .replace(/\/+$/, "")
        .split("/")
        .some((part) => part.startsWith(".") && part.length > 1)
    const preferHidden = query.startsWith(".") || query.includes("/.")
    const hiddenLast = (items: string[]) =>
      preferHidden ? items : [...items.filter((item) => !hidden(item)), ...items.filter(hidden)]
    if (!query)
      return kind === "file" ? result.files.slice(0, limit) : hiddenLast(result.dirs.toSorted()).slice(0, limit)
    const items =
      kind === "file" ? result.files : kind === "directory" ? result.dirs : [...result.files, ...result.dirs]
    const sorted = fuzzysort
      .go(query, items, { limit: kind === "directory" && !preferHidden ? limit * 20 : limit })
      .map((item) => item.target)
    return kind === "directory" ? hiddenLast(sorted).slice(0, limit) : sorted
  }
}
