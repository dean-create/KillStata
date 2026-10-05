import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Ripgrep } from "../../src/file/ripgrep"

// rg 搜索防护：默认忽略清单（node_modules / .killstata 等）+ 超时/中止抛明确的 Ripgrep.RipgrepTimeoutError
// （对齐 claude-code 区分"无匹配"与"没搜完"）。

async function mkProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "killstata-rg-guard-"))
  await fs.writeFile(path.join(dir, "src.txt"), "needle")
  await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true })
  await fs.writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "needle")
  await fs.mkdir(path.join(dir, ".killstata"), { recursive: true })
  await fs.writeFile(path.join(dir, ".killstata", "state.json"), "needle")
  await fs.mkdir(path.join(dir, "dist"), { recursive: true })
  await fs.writeFile(path.join(dir, "dist", "out.js"), "needle")
  return dir
}

async function rm(dir: string) {
  await fs.rm(dir, { recursive: true, force: true })
}

describe("Ripgrep default ignores", () => {
  test("files() 默认排除 node_modules/.killstata/dist", async () => {
    const dir = await mkProject()
    try {
      const files: string[] = []
      for await (const file of Ripgrep.files({ cwd: dir, timeoutMs: 5000 })) files.push(file)
      const has = (segment: string) => files.some((f) => f.includes(segment))
      expect(has("src.txt")).toBe(true)
      expect(has("node_modules")).toBe(false)
      expect(has(".killstata")).toBe(false)
      expect(has("dist")).toBe(false)
    } finally {
      await rm(dir)
    }
  })

  test("用户传的 include glob 与默认忽略叠加生效", async () => {
    const dir = await mkProject()
    try {
      const files: string[] = []
      for await (const file of Ripgrep.files({
        cwd: dir,
        glob: ["*.js"],
        timeoutMs: 5000,
      })) {
        files.push(file)
      }
      // node_modules/pkg/index.js 满足 *.js 但被默认排除；dist/out.js 也被排除
      expect(files.some((f) => f.includes("index.js"))).toBe(false)
      expect(files.some((f) => f.includes("out.js"))).toBe(false)
    } finally {
      await rm(dir)
    }
  })
})

describe("Ripgrep guard (timeout/abort)", () => {
  test("abort 中断 → 抛 Ripgrep.RipgrepTimeoutError(aborted:true)", async () => {
    // 造一个让 rg 扫得慢一点的目录：5000 个空文件
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "killstata-rg-abort-"))
    try {
      for (let i = 0; i < 5000; i++) {
        await fs.writeFile(path.join(dir, `f${i}.txt`), "x")
      }
      const ctrl = new AbortController()
      // 启动迭代器，但只读 0 行就 abort——确保是 abort 不是 timeout
      const iter = Ripgrep.files({ cwd: dir, timeoutMs: 30_000, abort: ctrl.signal })[Symbol.asyncIterator]()
      // 先 peek 一次（不读行也行：直接 abort 让下一轮 reader.read 抛）
      ctrl.abort()
      let error: unknown
      try {
        while (true) {
          const next = await iter.next()
          if (next.done) break
        }
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(Ripgrep.RipgrepTimeoutError)
      expect((error as InstanceType<typeof Ripgrep.RipgrepTimeoutError>).data.aborted).toBe(true)
    } finally {
      await rm(dir)
    }
  })

  test("timeoutMs=0 → 立即抛 Ripgrep.RipgrepTimeoutError（timedOutMs 透传）", async () => {
    const dir = await mkProject()
    try {
      let error: unknown
      try {
        for await (const _ of Ripgrep.files({ cwd: dir, timeoutMs: 0 })) {
          // 不会到这里
        }
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(Ripgrep.RipgrepTimeoutError)
      expect((error as InstanceType<typeof Ripgrep.RipgrepTimeoutError>).data.timedOutMs).toBe(0)
    } finally {
      await rm(dir)
    }
  })
})
