import { describe, expect, test } from "bun:test"
import { parseCleanupCommand } from "@/cli/cmd/tui/cleanup-command"

describe("parseCleanupCommand", () => {
  test("支持帮助文案公开的 keep=N 语法", () => {
    expect(parseCleanupCommand("/cleanup keep=10 --dry-run")).toEqual({
      matched: true,
      dryRun: true,
      keepTopSessions: 10,
    })
  })

  test("保留兼容的 keep N 语法并拒绝无效数量", () => {
    expect(parseCleanupCommand("/cleanup keep 7").keepTopSessions).toBe(7)
    expect(parseCleanupCommand("/cleanup keep=0").keepTopSessions).toBeUndefined()
    expect(parseCleanupCommand("/cleanup keep=oops").keepTopSessions).toBeUndefined()
  })

  test("非 cleanup 命令不匹配", () => {
    expect(parseCleanupCommand("请 cleanup 一下").matched).toBe(false)
  })
})
