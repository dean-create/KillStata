import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { classifyToolFailure, persistToolReflection } from "@/tool/analysis-reflection"
import { Instance } from "@/project/instance"

function classify(input: Parameters<typeof classifyToolFailure>[0]) {
  return Instance.provide({ directory: process.cwd(), fn: async () => classifyToolFailure(input) })
}

describe("analysis failure classification", () => {
  test("classifies managed-process timeout as a bounded execution failure", async () => {
    const reflection = await classify({
      toolName: "ols_regression",
      error: "ManagedProcessError: PROCESS_TIMEOUT 计量分析超过 300000ms",
    })

    expect(reflection.failureType).toBe("process_timeout")
    expect(reflection.retryStage).toBe("estimate")
    expect(reflection.repairAction).toContain("缩小")
    expect(reflection.repairAction).toContain("不要自动改用")
  })

  test("classifies Chinese Zod feedback as a model tool-contract error", async () => {
    const reflection = await classify({
      toolName: "iv_2sls",
      error: "计量工具参数不合法：instrumentVar：Required；covariance：Invalid option",
    })

    expect(reflection.failureType).toBe("tool_contract_failure")
    expect(reflection.retryStage).toBe("estimate")
    expect(reflection.repairAction).toContain("参数")
  })

  test("classifies an unavailable native tool as a contract error", async () => {
    const reflection = await classify({
      toolName: "hallucinated_estimator",
      error: "Model tried to call unavailable tool 'hallucinated_estimator'. Available tools: ols_regression.",
    })

    expect(reflection.failureType).toBe("tool_contract_failure")
    expect(reflection.repairAction).toContain("参数")
  })

  test("classifies a Python FileNotFoundError after private-path redaction", async () => {
    const reflection = await classify({
      toolName: "data_import",
      error: "FileNotFoundError: /Users/alice/My Project/private data.xlsx: source missing",
    })

    expect(reflection.failureType).toBe("file_not_found")
    expect(reflection.retryStage).toBe("ingest")
    expect(reflection.error).toContain("source missing")
    expect(reflection.error).not.toContain("/Users/alice")
  })

  test("persists a bounded redacted reflection with private permissions", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-reflection-"))
    const reflectionPath = await Instance.provide({
      directory,
      fn: async () => {
        const reflection = classifyToolFailure({
          toolName: "ols_regression",
          error: [
            "估计失败 api_key=sk-reflection-secret",
            "Traceback (most recent call last):",
            '  File "/Users/private/estimate.py", line 4, in <module>',
            "    estimate()",
            `ValueError: ${"x".repeat(20_000)}`,
          ].join("\n"),
          input: {
            datasetId: "dataset_1",
            api_key: "tiny-secret",
            wide: Array.from({ length: 50 }, (_, index) => `${index}:${"wide".repeat(375)}`),
          },
          sessionId: "session_1",
        })
        return persistToolReflection(reflection)
      },
    })

    const stored = fs.readFileSync(reflectionPath, "utf-8")
    expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(32 * 1024)
    expect(stored).not.toContain("sk-reflection-secret")
    expect(stored).not.toContain("tiny-secret")
    expect(stored).not.toContain("Traceback")
    expect(stored).not.toContain("/Users/private")
    expect(stored).toContain("[已脱敏]")
    expect(fs.statSync(reflectionPath).mode & 0o777).toBe(0o600)
    fs.rmSync(directory, { recursive: true, force: true })
  })

  test("never overwrites a concurrent reflection with the same tool and timestamp", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killstata-reflection-unique-"))
    const paths = await Instance.provide({
      directory,
      fn: async () => {
        const reflection = classifyToolFailure({
          toolName: "ols_regression",
          error: "estimation failed",
          sessionId: "session_same_millisecond",
        })
        reflection.createdAt = "2026-07-16T00:00:00.000Z"
        return [persistToolReflection(reflection), persistToolReflection(reflection)]
      },
    })

    expect(paths[0]).not.toBe(paths[1])
    expect(paths.every((filePath) => fs.existsSync(filePath))).toBe(true)
    fs.rmSync(directory, { recursive: true, force: true })
  })
})
