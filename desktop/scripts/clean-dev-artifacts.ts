import fs from "node:fs"
import path from "node:path"

export const CLEAN_TARGETS = [
  "dist",
  "src-tauri/target",
  "src-tauri/gen",
  "test-output",
] as const

export function cleanTargets(root = path.resolve(import.meta.dir, "..")) {
  for (const relative of CLEAN_TARGETS) {
    const target = path.resolve(root, relative)
    const relativeToRoot = path.relative(root, target)
    if (!relativeToRoot || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new Error(`拒绝清理工作区之外的路径：${target}`)
    }
    if (!fs.existsSync(target)) continue
    fs.rmSync(target, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  cleanTargets()
  console.log(`已清理 Desktop 开发产物：${CLEAN_TARGETS.join(", ")}`)
}
