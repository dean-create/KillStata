import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { runManagedProcess, summarizeManagedProcess } from "@/runtime/managed-process"
import { Shell } from "@/shell/shell"

let root = ""

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-managed-process-"))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function runScript(script: string, overrides: Partial<Parameters<typeof runManagedProcess>[0]> = {}) {
  return runManagedProcess({
    command: process.execPath,
    allowedCommands: [process.execPath],
    args: ["-e", script],
    cwd: root,
    allowedCwdRoot: root,
    timeoutMs: 2_000,
    maxOutputBytes: 1_024,
    ...overrides,
  })
}

describe("managed process", () => {
  test("captures stdout and stderr separately with exit metadata", async () => {
    const result = await runScript('process.stdout.write("RESULT"); process.stderr.write("WARNING")')

    expect(result.code).toBe(0)
    expect(result.stdout).toBe("RESULT")
    expect(result.stderr).toBe("WARNING")
    expect(result.stdoutTruncated).toBe(false)
    expect(result.stderrTruncated).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("builds a bounded execution summary without copying process output", async () => {
    const result = await runScript('process.stdout.write("PRIVATE DATA"); process.stderr.write("TRACE")')
    const summary = summarizeManagedProcess(result)

    expect(summary).toEqual({
      exitCode: 0,
      signal: null,
      durationMs: result.durationMs,
      stdoutBytes: 12,
      stderrBytes: 5,
      stdoutTruncated: false,
      stderrTruncated: false,
    })
    expect(summary).not.toHaveProperty("stdout")
    expect(summary).not.toHaveProperty("stderr")
  })

  test("keeps only the high-signal tail when a process floods stdout", async () => {
    const result = await runScript(
      'process.stdout.write("x".repeat(4096)); process.stdout.write("TAIL_MARKER")',
      { maxOutputBytes: 256 },
    )

    expect(result.stdoutBytes).toBeGreaterThan(4_096)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(256)
    expect(result.stdout).toEndWith("TAIL_MARKER")
    expect(result.stdoutTruncated).toBe(true)
  })

  test("terminates a process that exceeds its wall-clock budget", async () => {
    await expect(runScript("setInterval(() => {}, 1000)", { timeoutMs: 50 })).rejects.toMatchObject({
      code: "PROCESS_TIMEOUT",
      timeoutMs: 50,
    })
  })

  test("terminates descendants instead of leaving an analysis worker running", async () => {
    const marker = path.join(root, "descendant-survived")
    fs.rmSync(marker, { force: true })
    const childScript = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 200)`
    const parentScript = [
      'const { spawn } = require("child_process")',
      `spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" })`,
      "setInterval(() => {}, 1000)",
    ].join(";")

    await expect(runScript(parentScript, { timeoutMs: 50 })).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" })
    await Bun.sleep(300)
    expect(fs.existsSync(marker)).toBe(false)
  })

  test("terminates a process when the user aborts the tool", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)

    await expect(runScript("setInterval(() => {}, 1000)", { abort: controller.signal })).rejects.toMatchObject({
      code: "PROCESS_ABORTED",
    })
  })

  test("settles within a bounded grace period even when tree termination fails", async () => {
    const killTree = spyOn(Shell, "killTree").mockImplementation(() => new Promise(() => {}))
    const startedAt = Date.now()
    try {
      await expect(runScript("setTimeout(() => {}, 500)", { timeoutMs: 20 })).rejects.toMatchObject({
        code: "PROCESS_TIMEOUT",
      })
      expect(Date.now() - startedAt).toBeLessThan(450)
    } finally {
      killTree.mockRestore()
    }
  })

  test("does not lose an abort that happens between the precheck and listener registration", async () => {
    const controller = new AbortController()
    let firstRead = true
    const signal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === "aborted" && firstRead) {
          firstRead = false
          const current = target.aborted
          controller.abort()
          return current
        }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })

    await expect(runScript("setTimeout(() => {}, 150)", { abort: signal })).rejects.toMatchObject({
      code: "PROCESS_ABORTED",
    })
  })

  test("rejects a cwd outside the tool-owned root before spawn", async () => {
    await expect(runScript("", { cwd: os.tmpdir() })).rejects.toMatchObject({
      code: "PROCESS_CWD_DENIED",
    })
  })

  test("rejects an executable that is not on the internal allowlist", async () => {
    await expect(runScript("", { allowedCommands: ["python-that-is-not-selected"] })).rejects.toMatchObject({
      code: "PROCESS_COMMAND_DENIED",
    })
  })

  test("does not inherit model API keys into the analysis subprocess", async () => {
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = "sk-secret-that-must-not-reach-python"
    try {
      const result = await runScript('process.stdout.write(String(process.env.DEEPSEEK_API_KEY))')
      expect(result.stdout).toBe("undefined")
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous
    }
  })
})
