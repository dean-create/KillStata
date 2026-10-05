/**
 * Ripgrep.search 必须走 argv 直传，不经过 shell。
 *
 * 此前是 `args.join(" ")` 交给 Bun Shell 执行，而用户/模型提供的 pattern 被原样拼进命令
 * 字符串且没有引号：带空格的 pattern 会被切成两个参数（rg 把后半截当搜索路径），带 shell
 * 元字符的 pattern 会被展开甚至执行。pattern 直接来自模型的 grep 调用，是不可信输入。
 *
 * 同时锁住：默认忽略清单在 search 侧确实生效（`.killstata` 不该被搜出来），且 glob 不能
 * 带引号——走 argv 后引号会变成 pattern 的字面字符。
 */

import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Ripgrep } from "../../src/file/ripgrep"

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-rg-"))
  fs.mkdirSync(path.join(root, ".killstata", "datasets"), { recursive: true })
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.writeFileSync(path.join(root, ".killstata", "datasets", "internal.json"), "NEEDLE_TOKEN\n")
  fs.writeFileSync(path.join(root, "src", "visible.ts"), "NEEDLE_TOKEN\n")
  fs.writeFileSync(path.join(root, "src", "spaced.ts"), "hello world marker\n")
  return root
}

const paths = (hits: Array<{ path: { text: string } }>) => hits.map((hit) => hit.path.text).sort()

describe("Ripgrep.search argv", () => {
  test("带空格的 pattern 不被切碎——shell 拼接下 rg 会把后半截当搜索路径", async () => {
    const root = fixture()
    try {
      const hits = await Ripgrep.search({ cwd: root, pattern: "hello world" })
      expect(paths(hits as never)).toEqual(["src/spaced.ts"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("含 shell 元字符的 pattern 按字面处理，不被展开或执行", async () => {
    const root = fixture()
    try {
      const marker = path.join(root, "src", "pwned.txt")
      // 若仍走 shell，`$(...)` 会被求值并落地这个文件
      await Ripgrep.search({ cwd: root, pattern: `NEEDLE_TOKEN$(touch ${marker})` })
      expect(fs.existsSync(marker)).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("默认忽略清单在 search 侧生效：.killstata 内部文件不进搜索结果", async () => {
    const root = fixture()
    try {
      const hits = await Ripgrep.search({ cwd: root, pattern: "NEEDLE_TOKEN" })
      expect(paths(hits as never)).toEqual(["src/visible.ts"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
