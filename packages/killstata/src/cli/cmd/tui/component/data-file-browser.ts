import fs from "fs"
import os from "os"
import path from "path"
import { isDataFile } from "@/tool/data-file"

// 这些目录里不会有用户想分析的数据，列出来只会淹没真正的文件。
const IGNORED_DIRS = new Set([".git", "node_modules", ".killstata", "__pycache__", ".venv", "venv", "trash"])

/** 列表项要么是「进这个目录」，要么是「选这个文件」。 */
export type BrowserEntry =
  | { kind: "dir"; path: string; name: string }
  | { kind: "file"; path: string; name: string; size?: number }

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 把 ~ 展开成家目录并解析为绝对路径 —— 用户手打路径时习惯写 ~/Desktop/data.xlsx */
export function expandPath(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return trimmed
  if (trimmed === "~") return os.homedir()
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2))
  return path.resolve(trimmed)
}

/** 输入串看起来像不像用户在直接指一个路径（而不是在按名字筛选）。 */
export function looksLikePath(input: string) {
  const trimmed = input.trim()
  return trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.startsWith("./") || trimmed.startsWith("../")
}

/**
 * 列出一个目录里「可以进的子目录」和「可以选的数据文件」。
 * 只列本产品真能分析的格式 —— 把 .pdf/.txt 摆出来只会诱导用户选中然后失败。
 */
export function listDataDir(dir: string): { entries: BrowserEntry[]; error?: string } {
  let items: fs.Dirent[]
  try {
    items = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return { entries: [], error: e instanceof Error ? e.message : "无法读取该目录" }
  }

  const dirs: BrowserEntry[] = items
    .filter((i) => i.isDirectory() && !i.name.startsWith(".") && !IGNORED_DIRS.has(i.name))
    .map((i) => ({ kind: "dir" as const, path: path.join(dir, i.name), name: i.name }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const files: BrowserEntry[] = items
    .filter((i) => i.isFile() && isDataFile(i.name))
    .map((i) => {
      const full = path.join(dir, i.name)
      let size: number | undefined
      try {
        size = fs.statSync(full).size
      } catch {
        size = undefined
      }
      return { kind: "file" as const, path: full, name: i.name, size }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  return { entries: [...dirs, ...files] }
}

/** 当前目录的上一级；已经在根目录时返回 undefined。 */
export function parentDir(dir: string) {
  const parent = path.dirname(dir)
  return parent === dir ? undefined : parent
}
