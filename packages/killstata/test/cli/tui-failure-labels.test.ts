import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

// TUI 错误卡片的 FAILURE_TYPE_LABELS 必须覆盖 runtime 全部 FailureType：
// failure-reflection.ts 新增失败类型而 TUI 忘记补中文标签时，用户只会看到"未知错误"，
// 可操作信息被静默吞掉。该断言用源码字面量对齐，两个文件都改了才需要同步改测试。

const REFLECTION_SRC = path.join(process.cwd(), "src", "runtime", "failure-reflection.ts")
const SESSION_TSX = path.join(process.cwd(), "src", "cli", "cmd", "tui", "routes", "session", "index.tsx")

function extractFailureTypeLiterals(source: string): string[] {
  // FailureType union 形如 `| "file_not_found"` … `| "unknown_failure"`
  const block = source.match(/export type FailureType =([\s\S]*?)\n\s*\n/)
  if (!block) throw new Error("找不到 FailureType union 定义")
  return [...block[1].matchAll(/\| "([a-z_]+)"/g)].map((match) => match[1])
}

function extractLabelKeys(source: string): string[] {
  const block = source.match(/const FAILURE_TYPE_LABELS: Record<string, string> = \{([\s\S]*?)\n\}/)
  if (!block) throw new Error("找不到 FAILURE_TYPE_LABELS 定义")
  return [...block[1].matchAll(/([a-z_]+):/g)].map((match) => match[1])
}

describe("TUI failure labels", () => {
  test("every FailureType has a Chinese label", () => {
    const failureTypes = extractFailureTypeLiterals(fs.readFileSync(REFLECTION_SRC, "utf-8"))
    const labelKeys = extractLabelKeys(fs.readFileSync(SESSION_TSX, "utf-8"))
    expect(failureTypes.length).toBeGreaterThan(5)
    expect(labelKeys.sort()).toEqual(failureTypes.sort())
  })
})
