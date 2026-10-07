import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Config } from "@/config/config"

// config 写入保护（P0.3，对齐 claude-code 的写保护）：
// 原子写（temp+rename，写一半崩溃不损坏）+ 写前 .bak 轮换（误覆盖可找回）。

let root = ""

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-config-atomic-"))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("config atomic write", () => {
  test("update() 原子写：目标文件内容正确，且 .bak 保留旧版本", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const filepath = path.join(root, "killstata.json")
        fs.writeFileSync(filepath, JSON.stringify({ model: "first" }))

        await Config.update({ model: "second" } as never)

        const current = JSON.parse(fs.readFileSync(filepath, "utf-8"))
        expect(current.model).toBe("second")

        // .bak 必须是写前的内容（可回滚）
        const backup = JSON.parse(fs.readFileSync(filepath + ".bak", "utf-8"))
        expect(backup.model).toBe("first")

        // 不留临时文件
        expect(fs.existsSync(`${filepath}.tmp-${process.pid}`)).toBe(false)
      },
    })
  })
})
