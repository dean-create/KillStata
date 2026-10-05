/**
 * Phase 2a 验收：计量后端非零退出时，错误消息必须携带 stderr 尾部，
 * 而不是只报一个退出码（否则模型/用户完全不知道 Python 侧崩在哪）。
 *
 * 用一个"伪装成解释器"的可执行脚本触发非零退出：脚本本身往 stderr 写
 * 固定标记并 exit 9，后端据此抛出的错误应包含该标记。
 */
import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { runOlsBackend } from "../../../../trash/killstata-legacy-econometrics/tool/ols-backend"

const STDERR_MARKER = "KILLSTATA_BACKEND_STDERR_MARKER"

function withFakeInterpreter<T>(fn: (fakePython: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-backend-stderr-"))
  const fakePython = path.join(root, "fake-python.sh")
  fs.writeFileSync(fakePython, `#!/bin/sh\necho '${STDERR_MARKER}' >&2\nexit 9\n`, { mode: 0o755 })
  try {
    return fn(fakePython)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("计量后端非零退出错误消息", () => {
  test("OLS 后端崩溃时错误里带 stderr 片段而非只有退出码", async () => {
    await withFakeInterpreter(async (fakePython) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-backend-stderr-out-"))
      try {
        await expect(
          runOlsBackend({
            pythonCommand: fakePython,
            cwd: root,
            payload: {
              method: "ols_regression",
              dataPath: "/nonexistent.csv",
              outputDir: path.join(root, "out"),
              dependentVar: "y",
              treatmentVar: "x",
              covariance: "HC1",
            },
          }),
        ).rejects.toThrow(/KILLSTATA_BACKEND_STDERR_MARKER/)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  })
})
