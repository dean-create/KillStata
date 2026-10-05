import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { BashTool } from "@/tool/bash"

// bash 工具执行器安全面（Phase 1，对齐 managed-process）：
// env 白名单化（不再透传完整 process.env）+ 运行期输出上限（内存有界）。
// 用真实 bash 进程验证——这是安全改动，不能用源码字符串匹配代替行为验证。

let root = ""

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-bash-env-"))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function runBash(command: string) {
  const { execute } = await BashTool.init()
  const ctx = {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
  return execute({ command, description: `test: ${command}` }, ctx as never)
}

describe("bash env whitelist", () => {
  test("敏感变量不进子进程（白名单外的 env 一律丢弃）", async () => {
    const previous = process.env.KILLSTATA_TEST_SECRET
    process.env.KILLSTATA_TEST_SECRET = "super-secret-must-not-leak"
    try {
      const result = await Instance.provide({
        directory: root,
        fn: () => runBash('echo "leaked=$KILLSTATA_TEST_SECRET"'),
      })
      expect(result.output).not.toContain("super-secret-must-not-leak")
      expect(result.output).toContain("leaked=")
    } finally {
      if (previous === undefined) delete process.env.KILLSTATA_TEST_SECRET
      else process.env.KILLSTATA_TEST_SECRET = previous
    }
  })

  test("白名单 env（PATH/HOME）保留", async () => {
    const result = await Instance.provide({
      directory: root,
      fn: () => runBash('echo "path=$PATH home=$HOME"'),
    })
    expect(result.output).toContain("path=/")
    expect(result.output).toContain("home=")
    expect(result.output).not.toContain("home=undefined")
  })
})

describe("bash runtime output cap", () => {
  test("超大输出被截断并标记 outputTruncated", async () => {
    const result = await Instance.provide({
      directory: root,
      fn: () => runBash('python3 -c "print(chr(120) * 3000000)" || yes 2>/dev/null | head -c 3000000 || printf "x%.0s" {1..3000000}'),
    })
    expect(result.metadata.outputTruncated).toBe(true)
    // 截断标记要在返回文本里明确告知模型
    expect(result.output).toContain("runtime output truncated")
  })
})
