import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

describe("TUI 进程级退出", () => {
  test("启动器注册 SIGINT 清理 worker 和 Core，而不是只依赖组件键盘事件", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "cli", "cmd", "tui", "thread.ts"), "utf-8")
    expect(source).toContain('process.once("SIGINT"')
    expect(source).toContain('process.stdin.on("data"')
    expect(source).toContain('client.call("shutdown", undefined)')
    expect(source).toContain("worker.terminate()")
  })
})
