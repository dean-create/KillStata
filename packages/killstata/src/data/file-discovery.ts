import fs from "fs/promises"
import path from "path"
import { isDataFile } from "@/tool/data-file"

const IGNORED_DIRECTORIES = new Set([".git", ".killstata", "node_modules", "trash", "__pycache__", ".venv", "venv"])

/**
 * 只发现用户可以直接导入的数据文件。这里刻意不复用通用代码文件搜索：
 * 把仓库、运行产物和回收站混进补全，会诱导模型或用户选择错误输入。
 */
export async function findDataFiles(input: { root: string; query: string; limit?: number }) {
  const root = path.resolve(input.root)
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 200)
  const query = input.query.trim().toLocaleLowerCase()
  const files: string[] = []
  const pending = [root]

  while (pending.length > 0 && files.length < limit) {
    const directory = pending.shift()!
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      if (files.length >= limit) break
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(absolute)
        continue
      }
      if (!entry.isFile() || !isDataFile(entry.name)) continue

      const relative = path.relative(root, absolute)
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue
      const normalized = relative.split(path.sep).join("/")
      if (query && !normalized.toLocaleLowerCase().includes(query)) continue
      files.push(normalized)
    }
  }

  return files.toSorted((a, b) => a.localeCompare(b))
}
