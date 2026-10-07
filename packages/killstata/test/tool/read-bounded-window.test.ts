import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { ReadTool } from "../../src/tool/read"

const ctx = {
  sessionID: Identifier.descending("session"),
  messageID: "",
  callID: "",
  agent: "econometrics",
  abort: AbortSignal.any([]),
  metadata: async () => undefined,
  ask: async () => undefined,
} as any

describe("tool.read bounded text window", () => {
  test("expired tool-output references return guidance instead of a filesystem error", async () => {
    await Instance.provide({
      directory: fs.mkdtempSync(path.join(os.tmpdir(), "killstata-read-expired-ref-")),
      fn: async () => {
        const tool = await ReadTool.init()
        const result = await tool.execute({ filePath: "tool-output:tool_expiredreference" }, ctx)
        expect(result.output).toContain("分页输出引用已失效")
        expect(result.output).toContain("results.json")
      },
    })
  })

  test("legacy workspace tool-output paths with a json suffix resolve as expired references", async () => {
    await Instance.provide({
      directory: fs.mkdtempSync(path.join(os.tmpdir(), "killstata-read-legacy-ref-")),
      fn: async () => {
        const tool = await ReadTool.init()
        const result = await tool.execute({ filePath: ".killstata/workspace/tool-output/tool_expiredreference.json" }, ctx)
        expect(result.output).toContain("分页输出引用已失效")
        expect(result.output).not.toContain("标识不合法")
      },
    })
  })

  test("reading a directory returns list guidance instead of an empty file error", async () => {
    await Instance.provide({
      directory: fs.mkdtempSync(path.join(os.tmpdir(), "killstata-read-directory-")),
      fn: async () => {
        const tool = await ReadTool.init()
        const result = await tool.execute({ filePath: "." }, ctx)
        expect(result.output).toContain("目录")
        expect(result.output).toContain("list")
      },
    })
  })

  test("rejects an empty path before touching the filesystem", async () => {
    await Instance.provide({
      directory: fs.mkdtempSync(path.join(os.tmpdir(), "killstata-read-empty-")),
      fn: async () => {
        const tool = await ReadTool.init()
        await expect(tool.execute({ filePath: "" }, ctx)).rejects.toThrow("文件路径不能为空")
      },
    })
  })

  test("does not load the whole large text file before applying offset/limit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-read-window-"))
    try {
      const target = path.join(root, "large.log")
      fs.writeFileSync(target, Array.from({ length: 200_000 }, (_, index) => `line-${index}`).join("\n"))
      const result = await Instance.provide({
        directory: root,
        fn: async () => {
          const tool = await ReadTool.init()
          return tool.execute({ filePath: target, offset: 100_000, limit: 2 }, ctx)
        },
      })
      expect(result.output).toContain("line-100000")
      expect(result.output).toContain("line-100001")
      expect(result.output).not.toContain("line-0")
      expect(result.output).toContain("offset")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // 压缩过的 JSON / 单行 CSV 整个文件只有一行，且远超输出字节上限。窗口扫描必须仍然
  // 返回该行的开头，而不是因为缓冲区超限就吐出空内容。
  test("returns the head of a single line that exceeds the byte budget", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-read-longline-"))
    try {
      const target = path.join(root, "min.json")
      fs.writeFileSync(
        target,
        JSON.stringify({ rows: Array.from({ length: 5_000 }, (_, index) => ({ id: index, name: `value-${index}` })) }),
      )
      const result = await Instance.provide({
        directory: root,
        fn: async () => {
          const tool = await ReadTool.init()
          return tool.execute({ filePath: target }, ctx)
        },
      })
      expect(result.output).toContain('{"rows":[{"id":0,"name":"value-0"}')
      expect(result.output).toContain("...")
      expect(result.metadata.truncated).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
